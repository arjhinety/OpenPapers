"""Run a question set through the pipeline and aggregate gate/citation metrics.

    uv run python evals/run_eval.py evals/questions-v1.json --tier light
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path

from openpapers_agents.config import load_settings
from openpapers_agents.knowledge_graph import build_knowledge_graph
from openpapers_agents.runner import research, run_tag


def _rate(num: int, den: int) -> float | None:
    return round(num / den, 4) if den else None


def aggregate(rows: list[dict]) -> dict:
    ok = [r for r in rows if "metrics" in r]
    before = [r["metrics"].get("citation_check_before") or {} for r in ok]
    after = [r["metrics"].get("citation_check_after") or {} for r in ok]
    total = lambda xs, k: sum(x.get(k, 0) or 0 for x in xs)  # noqa: E731
    recorded = sum(r["metrics"]["evidence_recorded"] for r in ok)
    rejected = sum(r["metrics"]["evidence_rejected"] for r in ok)
    return {
        "runs": len(rows),
        "completed": len(ok),
        "shipped": sum(1 for r in ok if r["metrics"]["ship"]),
        "evidence_recorded": recorded,
        "evidence_rejected": rejected,
        "evidence_rejection_rate": _rate(rejected, recorded + rejected),
        "cited_sentences_before_repair": total(before, "total"),
        "supported_rate_before_repair": _rate(total(before, "supported"), total(before, "total")),
        "cited_sentences_after_repair": total(after, "total"),
        "supported_rate_after_repair": _rate(total(after, "supported"), total(after, "total")),
        "unsupported_removed": sum(r["metrics"]["unsupported_removed"] for r in ok),
        "hard_gate_failures": sum(r["metrics"]["gate"]["hard_failures"] for r in ok),
        "llm_calls": sum(r["metrics"]["llm_calls"] for r in ok),
        "cost_usd_reported": round(sum(r["metrics"]["cost_usd_reported"] for r in ok), 4),
        "median_seconds": sorted(r["metrics"]["seconds"] for r in ok)[len(ok) // 2] if ok else None,
    }


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("questions", type=Path)
    parser.add_argument("--tier", choices=["auto", "light", "full"], default="light")
    parser.add_argument("--max-subquestions", type=int, default=3)
    parser.add_argument("--research-steps", type=int, default=8)
    args = parser.parse_args()

    settings = load_settings()
    questions = json.loads(args.questions.read_text(encoding="utf-8"))
    batch_dir = settings.runs_dir / f"eval-{time.strftime('%Y%m%d-%H%M%S')}"
    rows = []
    for q in questions:
        run_dir = batch_dir / run_tag(q["query"])
        try:
            _, metrics = await research(q["query"], settings, tier=args.tier, max_subquestions=args.max_subquestions, research_steps=args.research_steps, run_dir=run_dir, knowledge_graph=False)
            rows.append({"id": q["id"], "query": q["query"], "run_dir": str(run_dir), "metrics": metrics})
        except Exception as exc:  # one failed question must not lose the batch
            rows.append({"id": q["id"], "query": q["query"], "run_dir": str(run_dir), "error": f"{type(exc).__name__}: {exc}"})
        print(json.dumps({k: v for k, v in rows[-1].items() if k != "metrics"} | {"ship": rows[-1].get("metrics", {}).get("ship")}), flush=True)

    graph = build_knowledge_graph([Path(r["run_dir"]) for r in rows if "metrics" in r], batch_dir / "graphify-out") if any("metrics" in r for r in rows) else {}
    result = {"model": settings.llm.model, "tier": args.tier, "summary": aggregate(rows), "knowledge_graph": graph, "runs": rows}
    out = Path(__file__).parent / "results" / f"{batch_dir.name}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result["summary"], indent=2))
    print(f"results: {out}")


if __name__ == "__main__":
    asyncio.run(main())
