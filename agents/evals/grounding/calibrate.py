"""Calibrate the LettuceDetect veto threshold against blind human-style labels.

    uv run --extra grounding python evals/grounding/calibrate.py

Pairs come from real runs (pairs-v1.jsonl); labels were assigned blind to all checker scores and
LLM verdicts (labels-v1.jsonl). The threshold is chosen on the `qlora` split and evaluated on the
held-out `dpo` split (different paper, different topic), so it is not tuned on what it is scored on.
"""

from __future__ import annotations

import json
import pathlib

from openpapers_agents.gates import CITE_RE
from openpapers_agents.grounding import LettuceDetectChecker, is_anaphoric, plain

HERE = pathlib.Path(__file__).parent
THRESHOLDS = [round(0.05 * i, 2) for i in range(1, 20)]


def load() -> list[dict]:
    labels = {r["id"]: r for r in map(json.loads, (HERE / "labels-v1.jsonl").read_text(encoding="utf-8").splitlines())}
    rows = [json.loads(l) for l in (HERE / "pairs-v1.jsonl").read_text(encoding="utf-8").splitlines()]
    for r in rows:
        r["label"] = labels[r["id"]]["label"]
    return rows


def prefixes_for(rows: list[dict]) -> list[str]:
    """Previous-sentence context for anaphoric claims, from the self-contained pairs file."""
    return [plain(CITE_RE.sub("", r["previous_sentence"])) if is_anaphoric(r["sentence"]) and r["previous_sentence"] else "" for r in rows]


def confusion(preds: list[int], labels: list[int]) -> dict:
    tp = sum(p == 1 and y == 1 for p, y in zip(preds, labels))
    tn = sum(p == 0 and y == 0 for p, y in zip(preds, labels))
    fp = sum(p == 1 and y == 0 for p, y in zip(preds, labels))
    fn = sum(p == 0 and y == 1 for p, y in zip(preds, labels))
    pos, neg = tp + fn, tn + fp
    return {
        "n": len(labels),
        "accuracy": round((tp + tn) / len(labels), 4),
        "balanced_accuracy": round(((tp / pos if pos else 0) + (tn / neg if neg else 0)) / 2, 4),
        "unsupported_recall": round(tn / neg, 4) if neg else None,  # share of unsupported sentences flagged
        "unsupported_precision": round(tn / (tn + fn), 4) if tn + fn else None,  # flagged that are truly unsupported
        "supported_passed": round(tp / pos, 4) if pos else None,
        "tp": tp, "tn": tn, "fp": fp, "fn": fn,
    }


def main() -> None:
    rows = load()
    checker = LettuceDetectChecker()
    pairs = [(plain(" ".join(r["quotes"])), plain(CITE_RE.sub("", r["sentence"]))) for r in rows]
    pre = prefixes_for(rows)
    scores = {"no_context": [], "anaphora_context": []}
    for n, r in enumerate(rows):  # per row so each gets its own run's question
        q = r["query"]
        scores["no_context"] += checker.support([pairs[n]], q)
        scores["anaphora_context"] += checker.support([pairs[n]], q, [pre[n]])

    result = {"pairs": len(rows), "anaphoric_pairs": sum(bool(p) for p in pre), "splits": {}}
    result["per_pair"] = [{"id": r["id"], "split": r["split"], "label": r["label"], "llm_verdict": r["llm_verdict"], **{k: scores[k][i] for k in scores}} for i, r in enumerate(rows)]
    for split, calib in (("qlora", True), ("dpo", False)):
        idx = [i for i, r in enumerate(rows) if r["split"] == split]
        labels = [rows[i]["label"] for i in idx]
        llm = [int(rows[i]["llm_verdict"] == "supported") for i in idx]
        result["splits"][split] = {"role": "calibration" if calib else "held-out", "llm_verifier": confusion(llm, labels)}
        for variant, vals in scores.items():
            sweep = {t: confusion([int(vals[i] >= t) for i in idx], labels) for t in THRESHOLDS}
            result["splits"][split][variant] = {"sweep": sweep}
    # choose on calibration split only: max balanced accuracy, ties -> lower threshold (fewer vetoes)
    for variant in scores:
        calib_sweep = result["splits"]["qlora"][variant]["sweep"]
        best = max(THRESHOLDS, key=lambda t: (calib_sweep[t]["balanced_accuracy"], -t))
        result[f"{variant}_threshold"] = best
        for split in ("qlora", "dpo"):
            idx = [i for i, r in enumerate(rows) if r["split"] == split]
            labels = [rows[i]["label"] for i in idx]
            chosen = [int(scores[variant][i] >= best) for i in idx]
            llm = [int(rows[i]["llm_verdict"] == "supported") for i in idx]
            combined = [a & b for a, b in zip(llm, chosen)]  # the pipeline's veto rule
            result["splits"][split][variant]["at_threshold"] = confusion(chosen, labels)
            result["splits"][split][variant]["veto_rule_llm_and_checker"] = confusion(combined, labels)
            result["splits"][split][variant]["at_0.5"] = result["splits"][split][variant]["sweep"][0.5]
    for variant in scores:
        for split in ("qlora", "dpo"):
            del result["splits"][split][variant]["sweep"]  # keep the file readable; recomputable
    (HERE / "calibration-v1.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
