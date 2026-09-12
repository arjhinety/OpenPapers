#!/usr/bin/env python3
"""Plot the frozen retrieval benchmark's Recall@K metrics.

Values are read from a recorded baseline artifact rather than hardcoded, so the chart cannot
drift away from the evidence its caption cites. Pass an artifact path to pin a specific run;
otherwise the latest committed `baseline-v1-*.json` is used.
"""

import json
import subprocess
import sys
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "evals" / "results"
OUTPUT = ROOT / "assets" / "retrieval-recall.png"


def committed_at(record_commit: str) -> int | None:
    """Commit timestamp for an artifact's anchor, or None if it does not resolve."""
    try:
        out = subprocess.run(
            ["git", "show", "-s", "--format=%ct", record_commit],
            cwd=ROOT, capture_output=True, text=True, check=True,
        )
        return int(out.stdout.strip())
    except (OSError, ValueError, subprocess.CalledProcessError):
        return None


def find_artifact() -> Path:
    """Newest baseline by COMMIT DATE, not filename.

    Artifact names embed a commit hash, so sorting by name orders them by hex digits and silently
    selects an arbitrary run -- it picked the superseded 12-query baseline over the current 44-query
    one. Every evidence anchor is reachable (see the evidence/* tags), so git history is the
    authoritative ordering.
    """
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    candidates = [
        path
        for path in RESULTS.glob("baseline-v1-*.json")
        if not path.name.endswith(("-failures.json", "-paper-code-failures.json"))
    ]
    if not candidates:
        sys.exit(f"error: no baseline-v1-*.json artifact found in {RESULTS}")
    dated = [
        (when, path)
        for path, when in ((path, committed_at(path.stem.split("-")[-1])) for path in candidates)
        if when is not None
    ]
    if not dated:
        sys.exit(
            "error: no baseline-v1 artifact has a resolvable commit anchor; "
            "pass an artifact path explicitly"
        )
    return max(dated)[1]


artifact = find_artifact()
try:
    record = json.loads(artifact.read_text(encoding="utf-8"))
    aggregate = record["retrieval"]["aggregate"]
    commit = record["commit"]
    queries = aggregate["queries"]
    RECALL = {
        "Recall@1": aggregate["recallAt1"],
        "Recall@5": aggregate["recallAt5"],
        "Recall@10": aggregate["recallAt10"],
    }
except (OSError, KeyError, ValueError) as error:
    sys.exit(f"error: cannot read retrieval aggregate from {artifact}: {error}")

plt.style.use("dark_background")
fig, ax = plt.subplots(figsize=(10, 6), dpi=180)
fig.patch.set_facecolor("#10151c")
ax.set_facecolor("#10151c")

labels = list(RECALL)
values = list(RECALL.values())
bars = ax.bar(
    labels,
    values,
    width=0.58,
    color=["#68d391", "#63b3ed", "#b794f4"],
    edgecolor="#f7fafc",
    linewidth=0.8,
)

ax.set_ylim(0, 1.08)
ax.yaxis.set_major_formatter(PercentFormatter(1.0))
ax.set_ylabel("Relevant target papers retrieved", color="#cbd5e0", labelpad=12)
ax.set_title("OpenPapers retrieval recall", loc="left", fontsize=22, fontweight="bold", pad=62)
ax.text(
    0,
    1.048,
    f"Frozen {queries}-query offline fixture benchmark · lexical-hash-v1 retriever · higher is better",
    transform=ax.transAxes,
    color="#a0aec0",
    fontsize=11,
)
ax.text(
    0,
    1.006,
    "Offline fixture corpus — not live fuzzy discovery (see docs/limitations.md)",
    transform=ax.transAxes,
    color="#718096",
    fontsize=9.5,
)

ax.grid(axis="y", color="#4a5568", alpha=0.35, linewidth=0.8)
ax.set_axisbelow(True)
for spine in ("top", "right", "left"):
    ax.spines[spine].set_visible(False)
ax.spines["bottom"].set_color("#4a5568")
ax.tick_params(axis="x", colors="#e2e8f0", labelsize=12, length=0, pad=10)
ax.tick_params(axis="y", colors="#a0aec0", labelsize=10, length=0)

for bar, value in zip(bars, values):
    ax.text(
        bar.get_x() + bar.get_width() / 2,
        value + 0.025,
        f"{value:.1%}",
        ha="center",
        va="bottom",
        color="#f7fafc",
        fontsize=13,
        fontweight="bold",
    )

fig.text(
    0.01,
    0.015,
    f"Source: {artifact.name} · commit {commit[:12]} · {queries} queries · Recall@10 = {RECALL['Recall@10']:.1%}",
    color="#718096",
    fontsize=9,
)
fig.tight_layout(rect=(0, 0.05, 1, 0.92))
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(OUTPUT, facecolor=fig.get_facecolor(), bbox_inches="tight")
print(f"Wrote {OUTPUT} from {artifact.name} (commit {commit[:12]}, {queries} queries)")
