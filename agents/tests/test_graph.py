"""Full-tier pipeline with a scripted model and fake OpenPapers: routing, fan-in, gates, repair."""

import json
import re
from typing import Any, Callable

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from openpapers_agents import prompts
from openpapers_agents.config import LLMSettings, Settings
from openpapers_agents.evidence import Ledger, SourceStore
from openpapers_agents.graph import RunContext, build_graph
from openpapers_agents.llm import LLM
from openpapers_agents.openpapers import ResearchTools

URL = "https://arxiv.org/html/2305.18290"
SECTIONS = [
    {"heading": "Abstract", "text": "Direct Preference Optimization (DPO) optimizes the policy without an explicit reward model."},
    {"heading": "6 Experiments", "text": "DPO with beta 0.1 matches or exceeds PPO on summarization. We use a batch size of 64 for all runs."},
]
QUOTES = {
    "Q1": "optimizes the policy without an explicit reward model",
    "Q2": "DPO with beta 0.1 matches or exceeds PPO on summarization",
    "L1": "We use a batch size of 64 for all runs",
}
DRAFT = (
    "# DPO in brief\n\n"
    "DPO optimizes the policy without an explicit reward model [E1]. "
    "DPO with beta 0.1 matches PPO on summarization at 70% win rate [E2]. "
    "A ghost claim is cited here for testing purposes [E9].\n\n"
    "## Limitations and open questions\n\nOnly one paper was read."
)


def _json(obj: Any) -> AIMessage:
    return AIMessage(content=json.dumps(obj))


def script(messages: list[BaseMessage]) -> AIMessage:
    system = messages[0].content
    task = messages[1].content if len(messages) > 1 else ""
    if system == prompts.PLANNER:
        return _json({"tier": "light", "subquestions": [{"id": "Q1", "question": "How does DPO avoid a reward model?"}, {"id": "Q2", "question": "How does DPO compare to PPO?"}], "success_criteria": ["compare to PPO"]})
    if system in (prompts.RESEARCHER, prompts.INVESTIGATOR):
        key = re.search(r"\((Q\d|L\d)\)", task).group(1)
        tool_results = [m for m in messages if isinstance(m, ToolMessage)]
        step = len(tool_results)
        if step == 0:
            return AIMessage(content="", tool_calls=[{"name": "read_paper", "args": {"url": "https://arxiv.org/abs/2305.18290"}, "id": f"{key}-1"}])
        if step == 1:  # paraphrase first: must be rejected by the ledger
            return AIMessage(content="", tool_calls=[{"name": "record_evidence", "args": {"source_url": URL, "quote": "DPO is better than PPO in every setting", "claim": "x"}, "id": f"{key}-2"}])
        if step == 2:
            return AIMessage(content="", tool_calls=[{"name": "record_evidence", "args": {"source_url": URL, "quote": QUOTES[key], "claim": "supported", "locator": "S"}, "id": f"{key}-3"}])
        evidence_id = re.search(r"RECORDED (E\d+)", tool_results[-1].content).group(1)
        if system == prompts.INVESTIGATOR:
            return _json({"position": "batch size is 64", "evidence_ids": [evidence_id], "confidence": "high"})
        return _json({"findings": [{"statement": "finding", "evidence_ids": [evidence_id, "E99"]}], "gaps": [], "tensions": []})
    if system == prompts.ANALYST:
        return _json({"loci": [{"id": "L1", "question": "What batch size is used?"}]})
    if system == prompts.WRITER:
        return AIMessage(content=f"<think>drafting</think>{DRAFT}")
    if any(system.startswith(c) for c in prompts.CRITICS.values()):
        return _json({"findings": [{"severity": "critical", "anchor": "A ghost claim is cited here for testing purposes [E9].", "issue": "unknown evidence"}]})
    if system == prompts.PATCHER:
        return _json({"edits": [{"find": "A ghost claim is cited here for testing purposes [E9].", "replace": ""}, {"find": "not in report", "replace": "x"}]})
    if system == prompts.VERIFIER:
        blocks = re.findall(r"(P\d+)\nSENTENCE: (.*)", messages[-1].content)
        return _json({"verdicts": [{"pair_id": pid, "verdict": "partial" if "70%" in s else "supported"} for pid, s in blocks]})
    if system == prompts.REPAIR:
        return _json({"edits": [{"find": "DPO with beta 0.1 matches PPO on summarization at 70% win rate [E2].", "replace": "DPO with beta 0.1 matches or exceeds PPO on summarization [E2]."}]})
    raise AssertionError(f"unscripted prompt: {system[:80]}")


class ScriptedModel(BaseChatModel):
    fn: Callable[[list[BaseMessage]], AIMessage]

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=self.fn(messages))])

    def bind_tools(self, tools, **kwargs):
        return self


async def fake_openpapers(name: str, args: dict[str, Any]) -> dict[str, Any]:
    assert name == "read_paper" and args["url"] == URL  # abs link was converted to HTML
    return {"title": "Direct Preference Optimization", "sections": SECTIONS}


async def run(tmp_path, tier, grounding=None):
    settings = Settings(llm=LLMSettings(model="fake", base_url=None, api_key=None, reasoning=True, timeout=5, max_retries=0))
    store = SourceStore()
    ledger = Ledger(store)
    ctx = RunContext(
        llm=LLM(settings, models={"fake": ScriptedModel(fn=script)}),
        tools=ResearchTools(fake_openpapers, store, ledger),
        ledger=ledger,
        store=store,
        run_dir=tmp_path,
        tier=tier,
        grounding=grounding or [],
    )
    result = await build_graph(ctx).ainvoke({"query": "How does DPO work and compare to PPO?"})
    events = [json.loads(line) for line in (tmp_path / "events.jsonl").read_text(encoding="utf-8").splitlines()]
    starts = {}
    for e in events:
        if e["event"] == "node_start":
            starts[e["node"]] = starts.get(e["node"], 0) + 1
    return result, starts


async def test_full_tier_pipeline(tmp_path):
    result, starts = await run(tmp_path, "full")
    assert starts == {"planner": 1, "researcher": 2, "analyst": 1, "investigator": 1, "writer": 1, "critic": 4, "patcher": 1, "cite_check": 1, "finalize": 1}

    m = result["metrics"]
    assert m["evidence_recorded"] == 3
    assert m["evidence_rejection_reasons"] == {"REJECTED_QUOTE_NOT_FOUND": 3}
    assert m["citation_check_before"]["partial"] == 1
    assert m["citation_check_after"]["supported_rate"] == 1.0
    assert m["gate"]["hard_failures"] == 0 and m["ship"] is True
    assert m["edits_applied"] == 2 and m["edits_rejected"] == 1

    report = result["report"]
    assert "E9" not in report and "70%" not in report and "<think>" not in report
    assert "## References" in report and URL in report
    # unknown ids in agent notes are dropped, not trusted
    assert all("E99" not in f["evidence_ids"] for n in result["notes"] for f in n["findings"])
    for name in ("report.md", "ledger.jsonl", "metrics.json", "cite_check.json", "critic_findings.json", "plan.json"):
        assert (tmp_path / name).exists()


async def test_light_tier_skips_depth_and_critics(tmp_path):
    result, starts = await run(tmp_path, "light")
    assert "analyst" not in starts and "critic" not in starts and "patcher" not in starts
    # without the critic pass the ghost citation reaches cite_check and is removed there
    assert "E9" not in result["report"]
    assert result["metrics"]["ship"] is True


class ScriptedChecker:
    """Rejects the reward-model sentence the LLM verifier accepts; supports everything else."""

    name = "scripted"

    def support(self, pairs, question):
        assert question.startswith("How does DPO")  # checkers receive the canonical query
        return [0.1 if "without an explicit reward model" in claim else 0.9 for _, claim in pairs]


async def test_independent_grounding_vetoes_llm_supported_sentence(tmp_path):
    result, _ = await run(tmp_path, "light", grounding=[ScriptedChecker()])
    g = result["metrics"]["grounding"]
    # 2 scored pairs (the [E9] sentence cites unknown evidence and is never scored):
    #   S1 reward-model sentence: LLM supported, checker 0.1 -> disagree, downgraded to partial
    #   S2 70% sentence:          LLM partial,   checker 0.9 -> disagree (checkers never upgrade)
    assert g == {"pairs_scored": 2, "agreement_rate": 0.0, "downgraded_to_repair": 1, "checker_support_rate": {"scripted": 0.5}, "threshold": 0.45}
    before = result["metrics"]["citation_check_before"]
    assert (before["supported"], before["partial"]) == (0, 2)
    verdicts = result["cite_check"]["verdicts_before"]
    s1 = next(v for s, v in verdicts.items() if "without an explicit reward model" in s)
    assert s1["llm_verdict"] == "supported" and s1["verdict"] == "partial" and s1["grounding"] == {"scripted": 0.1}

