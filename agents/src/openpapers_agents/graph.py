"""LangGraph pipeline: plan -> parallel research -> loci -> parallel depth -> draft -> parallel
critics -> surgical patch -> citation check + repair -> gated report.

Light tier skips loci, depth, critics and patching. Adapted from hyperresearch's width-then-depth
design, with the Claude-Code-specific parts (skills, tool allowlists) replaced by code-level
enforcement so any tool-calling model can run it.
"""

from __future__ import annotations

import asyncio
import json
import operator
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, Literal, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from . import prompts
from .evidence import Ledger, SourceStore
from .gates import CITE_RE, apply_edits, section_of_sentences, check_report, cited_ids, cited_pairs, dedupe_repeats, render_references, sentences, unquote_unverified
from .grounding import GroundingChecker, is_meta, plain, reconcile, score_pairs, vote
from .llm import LLM, run_tool_agent
from .openpapers import ResearchTools
from .schemas import CriticReport, DepthNote, LociPlan, PatchSet, Plan, ResearchNote, VerdictSet

VERIFY_BATCH = 8


class State(TypedDict, total=False):
    query: str
    plan: dict[str, Any]
    notes: Annotated[list[dict[str, Any]], operator.add]
    loci: list[dict[str, Any]]
    depth_notes: Annotated[list[dict[str, Any]], operator.add]
    draft: str
    critic_findings: Annotated[list[dict[str, Any]], operator.add]
    patched: str
    patch_log: Annotated[list[dict[str, Any]], operator.add]
    cite_check: dict[str, Any]
    report: str
    metrics: dict[str, Any]


@dataclass
class RunContext:
    llm: LLM
    tools: ResearchTools
    ledger: Ledger
    store: SourceStore
    run_dir: Path
    tier: Literal["auto", "light", "full"] = "auto"
    max_subquestions: int = 4
    research_steps: int = 10
    depth_steps: int = 10
    grounding: list[str | GroundingChecker] = field(default_factory=list)  # names load lazily
    grounding_threshold: float = 0.5
    query: str = ""
    started: float = field(default_factory=time.time)
    timings: dict[str, float] = field(default_factory=dict)

    def write(self, name: str, content: Any) -> None:
        path = self.run_dir / name
        path.write_text(content if isinstance(content, str) else json.dumps(content, indent=2, ensure_ascii=False), encoding="utf-8")

    def event(self, kind: str, **data: Any) -> None:
        with (self.run_dir / "events.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"t": round(time.time() - self.started, 2), "event": kind, **data}, ensure_ascii=False) + "\n")


def _tool_logger(ctx: RunContext, agent: str):
    def log(name: str, args: dict[str, Any], output: str) -> None:
        ctx.event("tool", agent=agent, tool=name, args={k: str(v)[:160] for k, v in args.items()}, result=output[:160])

    return log


def _timed(ctx: RunContext, name: str):
    def wrap(fn):
        async def node(payload: dict[str, Any]) -> dict[str, Any]:
            start = time.time()
            ctx.event("node_start", node=name)
            try:
                return await fn(payload)
            finally:
                elapsed = time.time() - start
                ctx.timings[name] = round(ctx.timings.get(name, 0.0) + elapsed, 2)
                ctx.event("node_end", node=name, seconds=round(elapsed, 2))

        node.__name__ = name
        return node

    return wrap


def _notes_digest(notes: list[dict[str, Any]], depth: list[dict[str, Any]] | None = None) -> str:
    parts = []
    for note in notes:
        sq = note["subquestion"]
        findings = "\n".join(f"  - {f['statement']} {f['evidence_ids']}" for f in note.get("findings", []))
        parts.append(
            f"{sq['id']}: {sq['question']}\n{findings or '  (no findings)'}"
            + (f"\n  gaps: {note['gaps']}" if note.get("gaps") else "")
            + (f"\n  tensions: {note['tensions']}" if note.get("tensions") else "")
        )
    for d in depth or []:
        parts.append(f"DEPTH {d['locus']['id']}: {d['locus']['question']}\n  position ({d.get('confidence')}): {d.get('position')} {d.get('evidence_ids')}\n  reasoning: {d.get('reasoning')}\n  would change mind: {d.get('would_change_mind')}")
    return "\n\n".join(parts)


def build_graph(ctx: RunContext):
    llm, ledger = ctx.llm, ctx.ledger

    def known(ids: list[str]) -> list[str]:
        return [i for i in ids if i in ledger.items]

    @_timed(ctx, "planner")
    async def planner(state: State) -> dict[str, Any]:
        ctx.query = state["query"]
        plan = await llm.json("planner", [SystemMessage(content=prompts.PLANNER), HumanMessage(content=prompts.canonical(state["query"]))], Plan)
        if ctx.tier != "auto":
            plan.tier = ctx.tier
        plan.subquestions = plan.subquestions[: ctx.max_subquestions]
        ctx.write("query.md", state["query"])
        ctx.write("plan.json", plan.model_dump())
        return {"plan": plan.model_dump()}

    def fan_out_research(state: State) -> list[Send]:
        return [Send("researcher", {"query": state["query"], "subq": sq}) for sq in state["plan"]["subquestions"]]

    @_timed(ctx, "researcher")
    async def researcher(payload: dict[str, Any]) -> dict[str, Any]:
        sq = payload["subq"]
        task = f"{prompts.canonical(payload['query'])}\n\nYour sub-question ({sq['id']}): {sq['question']}\nWhy it matters: {sq.get('rationale', '')}"
        try:
            note, calls = await run_tool_agent(llm, "researcher", prompts.RESEARCHER, task, ctx.tools.as_tools(f"researcher:{sq['id']}"), ResearchNote, ctx.research_steps, _tool_logger(ctx, f"researcher:{sq['id']}"))
        except Exception as exc:
            ctx.event("agent_error", agent=f"researcher:{sq['id']}", error=str(exc)[:500])
            return {"notes": [{"subquestion": sq, "findings": [], "gaps": [f"researcher failed: {exc}"], "tensions": [], "tool_calls": 0}]}
        findings = [{"statement": f.statement, "evidence_ids": known(f.evidence_ids)} for f in note.findings]
        return {"notes": [{"subquestion": sq, "findings": [f for f in findings if f["evidence_ids"]], "gaps": note.gaps, "tensions": note.tensions, "tool_calls": calls}]}

    def after_research(state: State) -> str:
        return "analyst" if state["plan"]["tier"] == "full" else "writer"

    @_timed(ctx, "analyst")
    async def analyst(state: State) -> dict[str, Any]:
        ctx.write("notes.json", state.get("notes", []))
        content = f"{prompts.canonical(state['query'])}\n\nResearch notes:\n{_notes_digest(state.get('notes', []))}\n\nEvidence ledger:\n{ledger.briefs(quote_chars=250)}"
        try:
            loci = await llm.json("analyst", [SystemMessage(content=prompts.ANALYST), HumanMessage(content=content)], LociPlan)
        except ValueError as exc:
            ctx.event("agent_error", agent="analyst", error=str(exc)[:500])
            return {"loci": []}
        ctx.write("loci.json", loci.model_dump())
        return {"loci": [l.model_dump() for l in loci.loci]}

    def fan_out_depth(state: State) -> list[Send] | str:
        loci = state.get("loci") or []
        if not loci:
            return "writer"
        return [Send("investigator", {"query": state["query"], "locus": l, "notes": state.get("notes", [])}) for l in loci]

    @_timed(ctx, "investigator")
    async def investigator(payload: dict[str, Any]) -> dict[str, Any]:
        locus = payload["locus"]
        task = (
            f"{prompts.canonical(payload['query'])}\n\nYour locus ({locus['id']}): {locus['question']}\nWhy: {locus.get('rationale', '')}\n\n"
            f"What the width pass found:\n{_notes_digest(payload['notes'])}\n\nExisting evidence (cite these ids or record new ones):\n{ledger.briefs(quote_chars=200)}"
        )
        try:
            note, calls = await run_tool_agent(llm, "researcher", prompts.INVESTIGATOR, task, ctx.tools.as_tools(f"investigator:{locus['id']}"), DepthNote, ctx.depth_steps, _tool_logger(ctx, f"investigator:{locus['id']}"))
        except Exception as exc:
            ctx.event("agent_error", agent=f"investigator:{locus['id']}", error=str(exc)[:500])
            return {"depth_notes": []}
        return {"depth_notes": [{"locus": locus, **note.model_dump(), "evidence_ids": known(note.evidence_ids), "tool_calls": calls}]}

    @_timed(ctx, "writer")
    async def writer(state: State) -> dict[str, Any]:
        ctx.write("notes.json", state.get("notes", []))
        ctx.write("depth_notes.json", state.get("depth_notes", []))
        plan = state["plan"]
        content = (
            f"{prompts.canonical(state['query'])}\n\nSub-questions: {json.dumps(plan['subquestions'])}\nSuccess criteria: {json.dumps(plan.get('success_criteria', []))}\n\n"
            f"Research and depth notes:\n{_notes_digest(state.get('notes', []), state.get('depth_notes', []))}\n\nEvidence ledger (the only citable material):\n{ledger.briefs(quote_chars=600)}"
        )
        draft = await llm.text("writer", [SystemMessage(content=prompts.WRITER), HumanMessage(content=content)])
        ctx.write("draft.md", draft)
        return {"draft": draft}

    def after_writer(state: State) -> list[Send] | str:
        if state["plan"]["tier"] != "full":
            return "cite_check"
        return [Send("critic", {"role": role, "state": state}) for role in prompts.CRITICS]

    @_timed(ctx, "critic")
    async def critic(payload: dict[str, Any]) -> dict[str, Any]:
        role, state = payload["role"], payload["state"]
        content = (
            f"{prompts.canonical(state['query'])}\n\nSuccess criteria: {json.dumps(state['plan'].get('success_criteria', []))}\n\n<draft>\n{state['draft']}\n</draft>\n\n"
            f"Notes:\n{_notes_digest(state.get('notes', []), state.get('depth_notes', []))}\n\nEvidence ledger:\n{ledger.briefs(quote_chars=300)}"
        )
        try:
            report = await llm.json("critic", [SystemMessage(content=f"{prompts.CRITICS[role]}\n{prompts.CRITIC_SUFFIX}"), HumanMessage(content=content)], CriticReport)
        except ValueError as exc:
            ctx.event("agent_error", agent=f"critic:{role}", error=str(exc)[:500])
            return {"critic_findings": []}
        return {"critic_findings": [{"critic": role, **f.model_dump(), "anchor_found": f.anchor in state["draft"]} for f in report.findings]}

    @_timed(ctx, "patcher")
    async def patcher(state: State) -> dict[str, Any]:
        findings = sorted(state.get("critic_findings", []), key=lambda f: ["critical", "major", "minor"].index(f["severity"]))
        ctx.write("critic_findings.json", findings)
        if not findings:
            return {"patched": state["draft"], "patch_log": []}
        content = (
            f"{prompts.canonical(state['query'])}\n\n<report>\n{state['draft']}\n</report>\n\nCritic findings:\n{json.dumps(findings, indent=1, ensure_ascii=False)}\n\n"
            f"Evidence ledger:\n{ledger.briefs(quote_chars=500)}"
        )
        try:
            patch = await llm.json("patcher", [SystemMessage(content=prompts.PATCHER), HumanMessage(content=content)], PatchSet)
        except ValueError as exc:
            ctx.event("agent_error", agent="patcher", error=str(exc)[:500])
            return {"patched": state["draft"], "patch_log": []}
        result = apply_edits(state["draft"], patch.edits, set(ledger.items))
        log = [{"stage": "critic_patch", "status": "applied", **e} for e in result.applied] + [{"stage": "critic_patch", "status": "rejected", **e} for e in result.rejected]
        return {"patched": result.text, "patch_log": log}

    async def verify(report: str) -> dict[str, dict[str, Any]]:
        """sentence -> verdict for every cited sentence."""
        pairs = cited_pairs(report)
        sections = section_of_sentences(report)
        verdicts: dict[str, dict[str, Any]] = {}
        to_check: list[tuple[str, list[str]]] = []
        for sentence, ids in pairs:
            if not known(ids):
                verdicts[sentence] = {"ids": ids, "verdict": "unsupported", "note": "cites unknown evidence"}
            else:
                to_check.append((sentence, ids))

        async def batch(chunk: list[tuple[str, list[str]]]) -> None:
            lines = []
            for n, (sentence, ids) in enumerate(chunk, 1):
                lines.append(f"P{n}\nSENTENCE: {sentence}\nEVIDENCE:\n{ledger.briefs(known(ids), quote_chars=700)}")
            try:
                result = await llm.json("verifier", [SystemMessage(content=prompts.VERIFIER), HumanMessage(content="\n\n".join(lines))], VerdictSet)
                by_id = {v.pair_id.upper().lstrip("P"): v for v in result.verdicts}
            except ValueError:
                by_id = {}
            for n, (sentence, ids) in enumerate(chunk, 1):
                verdict = by_id.get(str(n))
                verdicts[sentence] = {"ids": ids, "verdict": verdict.verdict if verdict else "unchecked", "note": verdict.note if verdict else "verifier returned no verdict"}

        async def ground() -> dict[str, dict[str, float]]:
            """Independent checkers score the same pairs in a worker thread (CPU-bound models)."""
            if not ctx.grounding or not to_check:
                return {}
            scorable = [(s, ids) for s, ids in to_check if not is_meta(sections.get(s, ""))]
            items = [(plain(" ".join(ledger.items[i].quote for i in known(ids))), plain(CITE_RE.sub("", s))) for s, ids in scorable]
            scores: dict[str, dict[str, float]] = {s: {} for s, _ in scorable}

            def on_error(name: str, exc: Exception) -> None:
                ctx.event("grounding_error", checker=name, error=f"{type(exc).__name__}: {exc}"[:300])

            by_checker = await asyncio.to_thread(score_pairs, ctx.grounding, items, ctx.query, on_error)
            for name, values in by_checker.items():
                for (sentence, _), value in zip(scorable, values):
                    scores[sentence][name] = value
            return scores

        llm_batches = asyncio.gather(*(batch(to_check[i : i + VERIFY_BATCH]) for i in range(0, len(to_check), VERIFY_BATCH)))
        _, grounded = await asyncio.gather(llm_batches, ground())
        for sentence, scores in grounded.items():
            if not scores or sentence not in verdicts:
                continue
            ballot = vote(scores, ctx.grounding_threshold)
            final, note = reconcile(verdicts[sentence]["verdict"], ballot)
            verdicts[sentence]["grounding"] = scores
            verdicts[sentence]["llm_verdict"] = verdicts[sentence]["verdict"]
            if note:
                verdicts[sentence].update(verdict=final, note=note)
        return verdicts

    @_timed(ctx, "cite_check")
    async def cite_check(state: State) -> dict[str, Any]:
        report = state.get("patched") or state["draft"]
        gate_before = check_report(report, ledger, ctx.store)
        verdicts_before = await verify(report)

        numeric = {n["sentence"] for n in gate_before.untraceable_numbers}
        flagged = [
            {"sentence": s, "ids": v["ids"], "problem": v["note"] or v["verdict"]}
            for s, v in verdicts_before.items()
            if v["verdict"] in {"partial", "unsupported"} or s[:300] in numeric
        ]
        flagged_sentences = {f["sentence"] for f in flagged}
        for quote in gate_before.quote_violations:
            for sentence in sentences(report):
                if quote in sentence and sentence not in flagged_sentences:
                    flagged.append({"sentence": sentence, "ids": cited_ids(sentence), "problem": f"quoted span is not verbatim in any source: \"{quote[:200]}\". Quote a ledger quote exactly or paraphrase without quotation marks."})
                    flagged_sentences.add(sentence)
        log: list[dict[str, Any]] = []
        if flagged:
            content = (
                f"{prompts.canonical(state['query'])}\n\n<report>\n{report}\n</report>\n\nFlagged sentences:\n{json.dumps(flagged, indent=1, ensure_ascii=False)}\n\n"
                f"Evidence ledger:\n{ledger.briefs(quote_chars=600)}"
            )
            try:
                patch = await llm.json("patcher", [SystemMessage(content=prompts.REPAIR), HumanMessage(content=content)], PatchSet)
                result = apply_edits(report, patch.edits, set(ledger.items))
                report = result.text
                log = [{"stage": "cite_repair", "status": "applied", **e} for e in result.applied] + [{"stage": "cite_repair", "status": "rejected", **e} for e in result.rejected]
            except ValueError as exc:
                ctx.event("agent_error", agent="cite_repair", error=str(exc)[:500])

        # re-verify only sentences the repair introduced or changed
        final_pairs = dict(cited_pairs(report))
        verdicts_after = {s: v for s, v in verdicts_before.items() if s in final_pairs}
        changed = [s for s in final_pairs if s not in verdicts_before]
        if changed:
            verdicts_after.update(await verify("\n".join(changed)))

        # hard floor: anything still unsupported is removed rather than shipped
        removed = []
        for sentence, verdict in list(verdicts_after.items()):
            if verdict["verdict"] == "unsupported" and report.count(sentence) == 1:
                report = report.replace(sentence, "", 1)
                removed.append(sentence)
                del verdicts_after[sentence]
        report, unquoted = unquote_unverified(report, ctx.store)

        def tally(verdicts: dict[str, dict[str, Any]]) -> dict[str, Any]:
            counts = {k: sum(1 for v in verdicts.values() if v["verdict"] == k) for k in ("supported", "partial", "unsupported", "unchecked")}
            total = sum(counts.values())
            return {**counts, "total": total, "supported_rate": round(counts["supported"] / total, 4) if total else None}

        summary = {
            "grounding": grounding_summary(verdicts_before),
            "before_repair": tally(verdicts_before),
            "after_repair": tally(verdicts_after),
            "flagged_for_repair": len(flagged),
            "removed_unsupported": removed,
            "unquoted_unverified": unquoted,
            "quote_violations_before": gate_before.quote_violations,
            "verdicts_before": verdicts_before,
            "verdicts_after": verdicts_after,
        }
        ctx.write("cite_check.json", summary)
        return {"patched": report, "cite_check": summary, "patch_log": log}

    @_timed(ctx, "finalize")
    async def finalize(state: State) -> dict[str, Any]:
        body, deduped = dedupe_repeats(state.get("patched") or state["draft"])
        report = render_references(body, ledger)
        gate = check_report(report, ledger, ctx.store)
        patch_log = state.get("patch_log", [])
        cite = state.get("cite_check", {})
        metrics = {
            "tier": state["plan"]["tier"],
            "subquestions": len(state["plan"]["subquestions"]),
            "loci": len(state.get("loci") or []),
            "sources_seen": ctx.store.source_count,
            "evidence_recorded": len(ledger.items),
            "evidence_rejected": len(ledger.rejections),
            "evidence_rejection_reasons": _count(r["reason"].split(":", 1)[0] for r in ledger.rejections),
            "research_tool_calls": sum(n.get("tool_calls", 0) for n in state.get("notes", [])) + sum(d.get("tool_calls", 0) for d in state.get("depth_notes", [])),
            "critic_findings": len(state.get("critic_findings", [])),
            "edits_applied": sum(1 for p in patch_log if p["status"] == "applied"),
            "edits_rejected": sum(1 for p in patch_log if p["status"] == "rejected"),
            "citation_check_before": cite.get("before_repair"),
            "citation_check_after": cite.get("after_repair"),
            "unsupported_removed": len(cite.get("removed_unsupported", [])),
            "grounding": cite.get("grounding"),
            "quote_violations_before_repair": len(cite.get("quote_violations_before", [])),
            "quotes_unquoted": len(cite.get("unquoted_unverified", [])),
            "repeated_sentences_removed": deduped,
            "gate": gate.as_dict(),
            "ship": gate.hard_failures == 0,
            "seconds": round(time.time() - ctx.started, 1),
            "node_seconds": ctx.timings,
            **llm.usage.as_dict(),
        }
        ctx.write("report.md", report)
        ctx.write("ledger.jsonl", ledger.to_jsonl())
        ctx.write("evidence_rejections.json", ledger.rejections)
        ctx.write("patches.json", patch_log)
        ctx.write("metrics.json", metrics)
        return {"report": report, "metrics": metrics}

    graph = StateGraph(State)
    for name, fn in [
        ("planner", planner),
        ("researcher", researcher),
        ("analyst", analyst),
        ("investigator", investigator),
        ("writer", writer),
        ("critic", critic),
        ("patcher", patcher),
        ("cite_check", cite_check),
        ("finalize", finalize),
    ]:
        graph.add_node(name, fn)
    graph.add_edge(START, "planner")
    graph.add_conditional_edges("planner", fan_out_research, ["researcher"])
    graph.add_conditional_edges("researcher", after_research, ["analyst", "writer"])
    graph.add_conditional_edges("analyst", fan_out_depth, ["investigator", "writer"])
    graph.add_edge("investigator", "writer")
    graph.add_conditional_edges("writer", after_writer, ["critic", "cite_check"])
    graph.add_edge("critic", "patcher")
    graph.add_edge("patcher", "cite_check")
    graph.add_edge("cite_check", "finalize")
    graph.add_edge("finalize", END)
    return graph.compile()


def grounding_summary(verdicts: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    """How often the independent checkers agree with the LLM verifier, per pair (same unit on
    both sides: one cited sentence)."""
    scored = [v for v in verdicts.values() if v.get("grounding")]
    if not scored:
        return None
    agree = 0
    per_checker: dict[str, list[float]] = {}
    for v in scored:
        ballot = vote(v["grounding"])
        llm_supported = v.get("llm_verdict", v["verdict"]) == "supported"
        agree += (ballot.supported_votes * 2 > ballot.total) == llm_supported
        for name, score in v["grounding"].items():
            per_checker.setdefault(name, []).append(score)
    return {
        "pairs_scored": len(scored),
        "agreement_rate": round(agree / len(scored), 4),
        "downgraded_to_repair": sum(1 for v in scored if v.get("llm_verdict") == "supported" and v["verdict"] != "supported"),
        "checker_support_rate": {name: round(sum(s >= 0.5 for s in vals) / len(vals), 4) for name, vals in per_checker.items()},
    }


def _count(items) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        counts[item] = counts.get(item, 0) + 1
    return counts
