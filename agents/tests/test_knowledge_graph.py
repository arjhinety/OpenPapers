import json

import pytest

from openpapers_agents.knowledge_graph import build_knowledge_graph, paper_id, run_extraction

pytest.importorskip("graphify")

URL_A = "https://arxiv.org/html/2305.18290"
URL_B = "https://arxiv.org/html/2106.09685"


def write_run(path, query, papers):
    path.mkdir(parents=True)
    (path / "query.md").write_text(query, encoding="utf-8")
    (path / "plan.json").write_text(json.dumps({"tier": "light", "subquestions": [{"id": "Q1", "question": "What is it?"}]}), encoding="utf-8")
    ledger = [{"id": f"E{i}", "source_url": url, "title": title, "locator": "S1", "quote": f"quote number {i} from {title}", "claim": f"claim {i}", "recorded_by": "t"} for i, (url, title) in enumerate(papers, 1)]
    (path / "ledger.jsonl").write_text("\n".join(json.dumps(x) for x in ledger), encoding="utf-8")
    (path / "notes.json").write_text(json.dumps([{"subquestion": {"id": "Q1", "question": "What is it?"}, "findings": [{"statement": "finding one", "evidence_ids": ["E1", "E9"]}]}]), encoding="utf-8")
    (path / "depth_notes.json").write_text("[]", encoding="utf-8")
    verdicts = {"Claim one is true [E1].": {"ids": ["E1"], "verdict": "supported"}, "Claim two is shaky [E2].": {"ids": ["E2"], "verdict": "partial"}}
    (path / "cite_check.json").write_text(json.dumps({"verdicts_after": verdicts}), encoding="utf-8")
    return path


def test_extraction_encodes_verification_state(tmp_path):
    run = write_run(tmp_path / "run1", "How does DPO work?", [(URL_A, "DPO"), (URL_B, "LoRA")])
    b = run_extraction(run)
    edges = {(e["source"].split("_", 1)[1], e["relation"], e["confidence"]) for e in b.edges}
    assert ("e1", "references", "EXTRACTED") in edges  # verified quote -> paper
    assert ("claim1", "cites", "EXTRACTED") in edges  # supported claim
    assert ("claim2", "cites", "INFERRED") in edges  # partial claim is downgraded
    assert not any(e["target"].endswith("e9") for e in b.edges)  # unknown evidence id dropped
    claim = next(n for n in b.nodes.values() if n["id"].endswith("claim1"))
    assert "[E1]" not in claim["label"] and claim["verdict"] == "supported"


def test_papers_merge_across_runs(tmp_path):
    r1 = write_run(tmp_path / "runs" / "a", "Q about DPO", [(URL_A, "DPO")])
    r2 = write_run(tmp_path / "runs" / "b", "Q about DPO vs LoRA", [(URL_A + "v3", "DPO"), (URL_B, "LoRA")])
    summary = build_knowledge_graph([r1, r2], tmp_path / "graph")
    assert summary["papers"] == 2  # the DPO paper is one node even with a versioned URL
    assert paper_id(URL_A) == paper_id(URL_A + "v3#S4")
    for name in ("graph.json", "GRAPH_REPORT.md", "extraction.json"):
        assert (tmp_path / "graph" / name).exists()
