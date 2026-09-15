"""Bridge to the OpenPapers MCP server and the research tools agents see.

OpenPapers returns a one-line text summary plus rich `structuredContent`; the tools below render the
structured part compactly for the model and index every returned span in the SourceStore so the
ledger can enforce quote integrity.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from contextlib import AsyncExitStack
from typing import Any, Awaitable, Callable

from langchain_core.tools import BaseTool, StructuredTool
from pydantic import BaseModel, Field

from .config import REPO_ROOT, Settings
from .evidence import Evidence, Ledger, SourceStore

CallFn = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]

_ARXIV_ID = re.compile(r"arxiv\.org/(?:abs|pdf|html)/(\d{4}\.\d{4,5})|10\.48550/arxiv\.(\d{4}\.\d{4,5})|\"arxiv(?:_?id)?\"\s*:\s*\"(\d{4}\.\d{4,5})", re.IGNORECASE)


def arxiv_html_url(url_or_blob: str) -> str | None:
    match = _ARXIV_ID.search(url_or_blob)
    if not match:
        return None
    return f"https://arxiv.org/html/{next(g for g in match.groups() if g)}"


def fence(tool: str, body: str, url: str = "") -> str:
    attr = f' url="{url}"' if url else ""
    return f'<untrusted-source tool="{tool}"{attr}>\n{body}\n</untrusted-source>'


def clip(text: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= limit else text[:limit] + " ..."


class OpenPapersBridge:
    """Owns one long-lived MCP stdio session; calls are cached and concurrency-limited."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._stack = AsyncExitStack()
        self._tools: dict[str, BaseTool] = {}
        self._sem = asyncio.Semaphore(settings.mcp_concurrency)
        self._cache: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.call_count = 0

    async def __aenter__(self) -> "OpenPapersBridge":
        from langchain_mcp_adapters.client import MultiServerMCPClient
        from langchain_mcp_adapters.tools import load_mcp_tools

        command, *args = self.settings.server_command
        env = {**os.environ, "LOG_LEVEL": os.getenv("OPA_MCP_LOG_LEVEL", "error"), "NODE_NO_WARNINGS": "1"}
        client = MultiServerMCPClient(
            {"openpapers": {"transport": "stdio", "command": command, "args": list(args), "cwd": str(REPO_ROOT), "env": env}}
        )
        session = await self._stack.enter_async_context(client.session("openpapers"))
        self._tools = {tool.name: tool for tool in await load_mcp_tools(session)}
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self._stack.aclose()

    async def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        key = f"{name}:{json.dumps(args, sort_keys=True)}"
        if key not in self._cache:
            self._cache[key] = asyncio.ensure_future(self._call(name, args))
        result = await self._cache[key]
        if "_error" in result:  # transient provider failures (429s) must stay retryable
            self._cache.pop(key, None)
        return result

    async def _call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        tool = self._tools.get(name)
        if tool is None:
            return {"_error": f"OpenPapers has no tool {name!r}"}
        async with self._sem:
            self.call_count += 1
            try:
                message = await tool.ainvoke({"name": name, "args": args, "id": f"opa-{self.call_count}", "type": "tool_call"})
            except Exception as exc:
                return {"_error": f"{type(exc).__name__}: {exc}"}
        artifact = message.artifact if isinstance(message.artifact, dict) else {}
        structured = artifact.get("structured_content")
        text = message.content if isinstance(message.content, str) else " ".join(
            block.get("text", "") for block in message.content if isinstance(block, dict)
        )
        if getattr(message, "status", "success") == "error":
            return {"_error": text or "tool error"}
        if not isinstance(structured, dict):
            return {"_text": text}
        return structured


# --- tool argument schemas ---------------------------------------------------------------------


class SearchArgs(BaseModel):
    query: str = Field(description="Keyword query, e.g. a method name plus the property you need.")
    limit: int = Field(default=6, ge=1, le=10)
    year_from: int | None = Field(default=None, description="Optional earliest publication year.")


class UrlArgs(BaseModel):
    url: str = Field(description="Paper URL. arXiv abs/pdf links are converted to arXiv HTML automatically.")


class SectionArgs(BaseModel):
    url: str
    section: str = Field(description="Section index from the read_paper outline (e.g. '7') or part of its heading.")
    offset: int = Field(default=0, ge=0, description="Character offset for long sections.")


class WithinArgs(BaseModel):
    url: str
    query: str = Field(description="Short lexical query; single distinctive terms work best.")
    limit: int = Field(default=5, ge=1, le=10)


class RecordArgs(BaseModel):
    source_url: str = Field(description="The exact paper URL the quote came from.")
    quote: str = Field(description="Verbatim span copied from tool output (15-700 chars). No paraphrase, no ellipses.")
    claim: str = Field(description="The claim this quote supports, in your own words.")
    locator: str = Field(default="", description="Section heading or other locator for the quote.")


# --- tool set ----------------------------------------------------------------------------------


class ResearchTools:
    """The tools researcher/investigator agents use; all output is fenced and indexed."""

    SECTION_CHARS = 5000

    def __init__(self, call: CallFn, store: SourceStore, ledger: Ledger) -> None:
        self._call = call
        self.store = store
        self.ledger = ledger
        self._sections: dict[str, list[dict[str, str]]] = {}
        self._titles: dict[str, str] = {}

    @staticmethod
    def _paper_url(url: str) -> str:
        url = url.strip()
        return arxiv_html_url(url) if re.search(r"arxiv\.org/(abs|pdf)/", url, re.I) else url

    async def search_papers(self, query: str, limit: int = 6, year_from: int | None = None) -> str:
        args: dict[str, Any] = {"query": query, "limit": limit}
        if year_from:
            args["year_from"] = year_from
        result = await self._call("search_papers", args)
        if "_error" in result:
            return f"ERROR: {result['_error']}"
        lines = []
        for item in (result.get("data") or [])[:limit]:
            blob = json.dumps(item)
            html = arxiv_html_url(blob)
            authors = ", ".join(a.get("name", "") if isinstance(a, dict) else str(a) for a in (item.get("authors") or [])[:3])
            title = item.get("title", "")
            meta = f"{title} ({item.get('year', '?')}) - {authors}"
            for url in filter(None, [html, item.get("canonicalUrl")]):
                self.store.add(url, meta, title=title)
            lines.append(
                f"- {meta}; citations={item.get('citationCount', '?')}; "
                + (f"read_url={html}" if html else f"url={item.get('canonicalUrl', '')} (no arXiv HTML; may not be readable)")
            )
        failures = (result.get("transparency") or {}).get("providerFailures") or []
        note = f"\n(provider failures: {'; '.join(failures)[:300]})" if failures else ""
        return fence("search_papers", "\n".join(lines) or "No results.", "") + note

    async def _load(self, url: str) -> tuple[str, list[dict[str, str]]] | str:
        url = self._paper_url(url)
        if url not in self._sections:
            result = await self._call("read_paper", {"url": url})
            if "_error" in result or "_text" in result:
                return f"ERROR reading {url}: {result.get('_error') or result.get('_text')}"
            sections = [s for s in result.get("sections") or [] if (s.get("text") or "").strip()]
            title = result.get("title") or ""
            self._titles[url] = title
            self._sections[url] = sections
            for section in sections:
                self.store.add(url, section["text"], title=title)
        return url, self._sections[url]

    async def read_paper(self, url: str) -> str:
        loaded = await self._load(url)
        if isinstance(loaded, str):
            return loaded
        url, sections = loaded
        outline = [
            f"[{i}] {clip(s.get('heading', ''), 90)} ({len(s['text'])} chars): {clip(s['text'], 220)}"
            for i, s in enumerate(sections[:70])
        ]
        body = f"Title: {self._titles.get(url, '')}\nURL: {url}\nSections (use read_section for full text):\n" + "\n".join(outline)
        return fence("read_paper", body, url)

    async def read_section(self, url: str, section: str, offset: int = 0) -> str:
        loaded = await self._load(url)
        if isinstance(loaded, str):
            return loaded
        url, sections = loaded
        chosen = None
        if section.strip().isdigit() and int(section) < len(sections):
            chosen = sections[int(section)]
        else:
            needle = section.strip().lower()
            chosen = next((s for s in sections if needle and needle in s.get("heading", "").lower()), None)
        if chosen is None:
            return f"ERROR: no section {section!r}; call read_paper for the outline."
        text = chosen["text"]
        window = text[offset : offset + self.SECTION_CHARS]
        more = f"\n[truncated: call again with offset={offset + self.SECTION_CHARS}]" if offset + self.SECTION_CHARS < len(text) else ""
        return fence("read_section", f"Section: {chosen.get('heading', '')}\n{window}{more}", url)

    async def search_within_paper(self, url: str, query: str, limit: int = 5) -> str:
        url = self._paper_url(url)
        result = await self._call("search_within_paper", {"url": url, "query": query, "limit": limit})
        if "_error" in result:
            return f"ERROR: {result['_error']}"
        lines = []
        for match in result.get("matches") or []:
            text = match.get("text", "")
            self.store.add(url, text)
            lines.append(f"- [{match.get('sectionHeading', '')}] {clip(text, 900)}")
        return fence("search_within_paper", "\n".join(lines) or "No matching chunks; try a different single term.", url)

    async def extract_paper_facts(self, url: str) -> str:
        url = self._paper_url(url)
        result = await self._call("extract_paper_facts", {"url": url})
        if "_error" in result:
            return f"ERROR: {result['_error']}"
        lines = ["Canonical facts:"]
        for fact in result.get("canonicalFacts") or []:
            raw = fact.get("rawEvidence", "")
            self.store.add(url, raw)
            section = (fact.get("locator") or {}).get("section", "")
            lines.append(f"- {fact.get('predicate')} = {fact.get('value')} [{section}] evidence: {clip(raw, 350)}")
        lines.append("Heuristic facts:")
        for fact in (result.get("facts") or [])[:10]:
            text = fact.get("text", "")
            self.store.add(url, text)
            section = (fact.get("locator") or {}).get("section", "")
            lines.append(f"- {fact.get('kind')} [{section}]: {clip(text, 350)}")
        return fence("extract_paper_facts", "\n".join(lines), url)

    def record_evidence_for(self, agent: str) -> Callable[..., Awaitable[str]]:
        async def record_evidence(source_url: str, quote: str, claim: str, locator: str = "") -> str:
            outcome = self.ledger.record(self._paper_url(source_url), quote, claim, locator, agent)
            if isinstance(outcome, Evidence):
                return f"RECORDED {outcome.id}. Cite it as [{outcome.id}]."
            return outcome

        return record_evidence

    def as_tools(self, agent: str) -> list[BaseTool]:
        spec = [
            (self.search_papers, "search_papers", "Search scholarly metadata (arXiv, Crossref, OpenAlex, Semantic Scholar). Returns read_url for readable arXiv HTML papers.", SearchArgs),
            (self.read_paper, "read_paper", "Fetch and parse a paper; returns title and a section outline with previews.", UrlArgs),
            (self.read_section, "read_section", "Return the full text of one section of a paper already listed by read_paper.", SectionArgs),
            (self.search_within_paper, "search_within_paper", "Lexical search inside one paper; returns matching passages with section headings.", WithinArgs),
            (self.extract_paper_facts, "extract_paper_facts", "Deterministic extraction of source-located facts (methods, hyperparameters, datasets) from a paper.", UrlArgs),
            (self.record_evidence_for(agent), "record_evidence", "Record a verbatim quote as evidence. Rejected unless the quote occurs verbatim in tool output for that URL.", RecordArgs),
        ]
        return [StructuredTool.from_function(coroutine=fn, name=name, description=desc, args_schema=schema) for fn, name, desc, schema in spec]
