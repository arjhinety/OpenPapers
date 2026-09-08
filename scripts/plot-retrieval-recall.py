#!/usr/bin/env python3
"""Plot the frozen retrieval benchmark's Recall@K metrics."""

from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter


RECALL = {
    "Recall@1": 0.4204545454545455,
    "Recall@5": 0.75,
    "Recall@10": 0.8560606060606062,
}

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets" / "retrieval-recall.png"

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
ax.set_title("OpenPapers retrieval recall", loc="left", fontsize=22, fontweight="bold", pad=20)
ax.text(
    0,
    1.015,
    "Frozen 44-query benchmark · higher is better",
    transform=ax.transAxes,
    color="#a0aec0",
    fontsize=11,
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
    "Source: evals/results/baseline-v1 · 44 retrieval queries · Recall@10 = 85.6%",
    color="#718096",
    fontsize=9,
)
fig.tight_layout(rect=(0, 0.05, 1, 0.96))
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(OUTPUT, facecolor=fig.get_facecolor(), bbox_inches="tight")
print(f"Wrote {OUTPUT}")
