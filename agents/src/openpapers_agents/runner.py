"""Run one research query end to end and return the run directory and metrics."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Literal

from .config import Settings, load_settings
from .evidence import Ledger, SourceStore
from .graph import RunContext, build_graph
from .grounding import resolve_checkers
from .tracing import trace_run
from .llm import LLM
from .openpapers import OpenPapersBridge, ResearchTools


def run_tag(query: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", query.lower()).strip("-")[:48]
    return f"{time.strftime('%Y%m%d-%H%M%S')}-{slug}"


async def research(
    query: str,
    settings: Settings | None = None,
    tier: Literal["auto", "light", "full"] = "auto",
    max_subquestions: int = 4,
    research_steps: int = 10,
    depth_steps: int = 10,
    run_dir: Path | None = None,
    knowledge_graph: bool = True,
    grounding: bool = True,
) -> tuple[Path, dict[str, Any]]:
    settings = settings or load_settings()
    run_dir = run_dir or settings.runs_dir / run_tag(query)
    run_dir.mkdir(parents=True, exist_ok=True)
    store = SourceStore()
    ledger = Ledger(store)
    llm = LLM(settings)
    checkers, grounding_problems = resolve_checkers() if grounding else ([], [])
    try:
        async with OpenPapersBridge(settings) as bridge:
            ctx = RunContext(
                llm=llm,
                tools=ResearchTools(bridge.call, store, ledger),
                ledger=ledger,
                store=store,
                run_dir=run_dir,
                tier=tier,
                max_subquestions=max_subquestions,
                research_steps=research_steps,
                depth_steps=depth_steps,
                grounding=checkers,
                grounding_threshold=float(os.getenv("OPA_GROUNDING_THRESHOLD", "0.5")),
            )
            ctx.write("config.json", {"model": settings.llm.model, "role_models": settings.role_models, "base_url": settings.llm.base_url, "tier": tier, "max_subquestions": max_subquestions, "research_steps": research_steps, "depth_steps": depth_steps, "grounding": checkers, "grounding_problems": grounding_problems})
            trace_meta = {"run_dir": run_dir.name, "tier": tier, "model": settings.llm.model, "query": query}
            with trace_run(f"research: {query[:80]}", trace_meta) as trace:
                result = await build_graph(ctx).ainvoke(
                    {"query": query},
                    config={"recursion_limit": 60, "callbacks": trace.callbacks, "run_name": "openpapers-research"},
                )
                metrics = {**result["metrics"], "mcp_calls": bridge.call_count}
                if knowledge_graph:
                    metrics["knowledge_graph"] = _graph(run_dir)
                metrics["tracing"] = {"enabled": trace.enabled, "trace_id": trace.trace_id, "scores_sent": trace.score(metrics)}
            ctx.write("metrics.json", metrics)
    finally:
        await llm.aclose()
    return run_dir, metrics


def _graph(run_dir: Path) -> dict[str, Any]:
    """graphify is optional at runtime: a graph failure never fails the research run."""
    try:
        from .knowledge_graph import build_knowledge_graph

        return build_knowledge_graph([run_dir], run_dir / "graphify-out")
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="openpapers-agents", description="Multi-agent, citation-gated literature research over OpenPapers.")
    parser.add_argument("query")
    parser.add_argument("--tier", choices=["auto", "light", "full"], default="auto")
    parser.add_argument("--max-subquestions", type=int, default=4)
    parser.add_argument("--research-steps", type=int, default=10)
    parser.add_argument("--depth-steps", type=int, default=10)
    parser.add_argument("--run-dir", type=Path)
    parser.add_argument("--no-graph", action="store_true", help="Skip the graphify knowledge graph.")
    parser.add_argument("--no-grounding", action="store_true", help="Skip the independent LettuceDetect/MiniCheck vote.")
    args = parser.parse_args(argv)
    run_dir, metrics = asyncio.run(
        research(args.query, tier=args.tier, max_subquestions=args.max_subquestions, research_steps=args.research_steps, depth_steps=args.depth_steps, run_dir=args.run_dir, knowledge_graph=not args.no_graph, grounding=not args.no_grounding)
    )
    summary = {k: metrics[k] for k in ("tier", "evidence_recorded", "evidence_rejected", "citation_check_before", "citation_check_after", "ship", "seconds", "llm_calls", "cost_usd_reported") if k in metrics}
    summary["grounding"] = metrics.get("grounding")
    summary["knowledge_graph"] = metrics.get("knowledge_graph")
    summary["tracing"] = metrics.get("tracing")
    print(json.dumps(summary, indent=2))
    print(f"report: {run_dir / 'report.md'}")
    return 0 if metrics["ship"] else 2


if __name__ == "__main__":
    sys.exit(main())
