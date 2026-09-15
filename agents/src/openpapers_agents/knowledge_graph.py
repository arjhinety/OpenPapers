"""Turn research runs into a graphify knowledge graph (graph.json, graph.html, GRAPH_REPORT.md).

The extraction is built deterministically from run artifacts, so no extra LLM pass is needed, and
edge confidence carries the pipeline's verification state:

  evidence --references--> paper        EXTRACTED 1.0  (quote machine-verified verbatim in the paper)
  claim    --cites-------> evidence     EXTRACTED 1.0 if the verifier judged it supported, else INFERRED
  finding  --cites-------> evidence     INFERRED 0.7   (agent assertion, not independently checked)

Paper ids are derived from the canonical source URL, so the same paper merges across runs.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from .evidence import source_key


def _slug(text: str, limit: int = 40) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:limit] or "x"


def _short(text: str, limit: int = 110) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _read(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    if path.suffix == ".jsonl":
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if path.suffix == ".json":
        return json.loads(path.read_text(encoding="utf-8"))
    return path.read_text(encoding="utf-8")


def paper_id(url: str) -> str:
    key = source_key(url)
    return "paper_" + _slug(key, 60) + "_" + hashlib.sha1(key.encode()).hexdigest()[:6]


class _Builder:
    def __init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}
        self.edges: list[dict[str, Any]] = []

    def node(self, node_id: str, label: str, file_type: str, source_file: Path, **extra: Any) -> str:
        if node_id not in self.nodes:
            self.nodes[node_id] = {
                "id": node_id,
                "label": _short(label),
                "file_type": file_type,
                "source_file": str(source_file),
                "source_location": extra.pop("source_location", None),
                "source_url": extra.pop("source_url", None),
                "captured_at": extra.pop("captured_at", None),
                "author": None,
                "contributor": extra.pop("contributor", None),
                **extra,
            }
        return node_id

    def edge(self, source: str, target: str, relation: str, source_file: Path, confident: bool, score: float | None = None) -> None:
        if source in self.nodes and target in self.nodes and source != target:
            self.edges.append(
                {
                    "source": source,
                    "target": target,
                    "relation": relation,
                    "confidence": "EXTRACTED" if confident else "INFERRED",
                    "confidence_score": score if score is not None else (1.0 if confident else 0.7),
                    "source_file": str(source_file),
                    "source_location": None,
                    "weight": 1.0,
                }
            )


def run_extraction(run_dir: Path, builder: _Builder | None = None) -> _Builder:
    b = builder or _Builder()
    run_dir = run_dir.resolve()
    tag = "r" + hashlib.sha1(run_dir.name.encode()).hexdigest()[:6]
    query = _read(run_dir / "query.md", "").strip()
    plan = _read(run_dir / "plan.json", {})
    ledger = _read(run_dir / "ledger.jsonl", [])
    notes = _read(run_dir / "notes.json", [])
    depth = _read(run_dir / "depth_notes.json", [])
    cite = _read(run_dir / "cite_check.json", {})

    query_id = b.node(f"{tag}_query", f"Query: {query}", "concept", run_dir / "query.md", contributor=run_dir.name)
    for sq in plan.get("subquestions", []):
        sq_id = b.node(f"{tag}_{_slug(sq['id'])}", f"{sq['id']}: {sq['question']}", "concept", run_dir / "plan.json")
        b.edge(sq_id, query_id, "conceptually_related_to", run_dir / "plan.json", True)

    evidence_ids: dict[str, str] = {}
    for item in ledger:
        pid = b.node(paper_id(item["source_url"]), item.get("title") or item["source_url"], "paper", run_dir / "ledger.jsonl", source_url=item["source_url"])
        eid = b.node(
            f"{tag}_{item['id'].lower()}",
            f"{item['id']}: {item.get('claim') or item['quote']}",
            "document",
            run_dir / "ledger.jsonl",
            source_location=item.get("locator") or None,
            source_url=item["source_url"],
            quote=item["quote"],
        )
        evidence_ids[item["id"]] = eid
        b.edge(eid, pid, "references", run_dir / "ledger.jsonl", True)

    for note in notes:
        sq_id = f"{tag}_{_slug(note['subquestion']['id'])}"
        for n, finding in enumerate(note.get("findings", []), 1):
            fid = b.node(f"{sq_id}_f{n}", finding["statement"], "concept", run_dir / "notes.json")
            b.edge(fid, sq_id, "rationale_for", run_dir / "notes.json", False, 0.8)
            for ev in finding.get("evidence_ids", []):
                b.edge(fid, evidence_ids.get(ev, ""), "cites", run_dir / "notes.json", False)

    for d in depth:
        locus = d["locus"]
        lid = b.node(f"{tag}_{_slug(locus['id'])}", f"{locus['id']}: {locus['question']}", "concept", run_dir / "depth_notes.json")
        b.edge(lid, query_id, "conceptually_related_to", run_dir / "depth_notes.json", True)
        pos = b.node(f"{lid}_position", f"Position ({d.get('confidence', '?')}): {d.get('position', '')}", "rationale", run_dir / "depth_notes.json")
        b.edge(pos, lid, "rationale_for", run_dir / "depth_notes.json", False, 0.8)
        for ev in d.get("evidence_ids", []):
            b.edge(pos, evidence_ids.get(ev, ""), "cites", run_dir / "depth_notes.json", False)

    for n, (sentence, verdict) in enumerate((cite.get("verdicts_after") or {}).items(), 1):
        cid = b.node(f"{tag}_claim{n}", re.sub(r"\s*\[E\d+(?:\s*[,;]\s*E\d+)*\]", "", sentence), "concept", run_dir / "report.md", verdict=verdict["verdict"])
        supported = verdict["verdict"] == "supported"
        for ev in verdict.get("ids", []):
            b.edge(cid, evidence_ids.get(ev, ""), "cites", run_dir / "report.md", supported, None if supported else 0.5)
    return b


def _community_labels(G: Any, communities: dict[int, list[str]]) -> dict[int, str]:
    labels: dict[int, str] = {}
    for cid, members in communities.items():
        data = [(m, G.nodes[m]) for m in members if m in G.nodes]
        topic = next((d["label"] for _, d in data if re.match(r"(Q|L)\d+:", d.get("label", ""))), None)
        if topic is None:
            papers = sorted((G.degree(m), d["label"]) for m, d in data if d.get("file_type") == "paper")
            topic = papers[-1][1] if papers else None
        if topic is None and data:  # otherwise the best-connected evidence/claim names the cluster
            ranked = sorted(data, key=lambda item: (item[1].get("file_type") == "document", G.degree(item[0])))
            topic = re.sub(r"^E\d+:\s*", "", ranked[-1][1].get("label", ""))
        labels[cid] = _short(topic or f"Community {cid}", 60)
    return labels


def build_knowledge_graph(run_dirs: list[Path], out_dir: Path) -> dict[str, Any]:
    """Build one graphify graph from one or more runs; returns a summary for metrics."""
    from graphify.analyze import god_nodes, suggest_questions, surprising_connections
    from graphify.build import build_from_json
    from graphify.cluster import cluster, score_all
    from graphify.export import to_html, to_json
    from graphify.report import generate

    builder = _Builder()
    for run_dir in run_dirs:
        run_extraction(run_dir, builder)
    extraction = {"nodes": list(builder.nodes.values()), "edges": builder.edges, "hyperedges": [], "input_tokens": 0, "output_tokens": 0}
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "extraction.json").write_text(json.dumps(extraction, indent=2, ensure_ascii=False), encoding="utf-8")

    root = run_dirs[0].resolve() if len(run_dirs) == 1 else run_dirs[0].resolve().parent
    G = build_from_json(extraction, root=str(root), directed=True)
    if G.number_of_nodes() == 0:
        return {"nodes": 0, "edges": 0, "communities": 0}
    communities = cluster(G)
    cohesion = score_all(G, communities)
    labels = _community_labels(G, communities)
    gods = god_nodes(G)
    surprises = surprising_connections(G, communities)
    questions = suggest_questions(G, communities, labels)

    to_json(G, communities, str(out_dir / "graph.json"), force=True, community_labels=labels)
    try:
        to_html(G, communities, str(out_dir / "graph.html"), community_labels=labels)
    except ValueError:
        pass  # graphify refuses oversized graphs; json + report still land
    words = sum(len(str(n.get("label", "")).split()) + len(str(n.get("quote", "")).split()) for n in builder.nodes.values())
    detection = {"total_files": len(run_dirs), "total_words": words, "warning": None}
    report = generate(G, communities, cohesion, labels, gods, surprises, detection, {"input": 0, "output": 0}, str(root), suggested_questions=questions)
    (out_dir / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")
    return {
        "nodes": G.number_of_nodes(),
        "edges": G.number_of_edges(),
        "communities": len(communities),
        "papers": sum(1 for n in builder.nodes.values() if n["file_type"] == "paper"),
        "god_nodes": [g.get("label") for g in gods[:5]],
        "out_dir": str(out_dir),
    }


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="openpapers-graph", description="Build a graphify knowledge graph from one or more research runs.")
    parser.add_argument("runs", nargs="+", type=Path, help="Run directories (runs/<tag>)")
    parser.add_argument("--out", type=Path, help="Output directory (default: <run>/graphify-out, or runs/_graph for several runs)")
    args = parser.parse_args(argv)
    out = args.out or (args.runs[0] / "graphify-out" if len(args.runs) == 1 else args.runs[0].resolve().parent / "_graph")
    print(json.dumps(build_knowledge_graph(args.runs, out), indent=2))
    return 0
