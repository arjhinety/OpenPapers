"""Pre-flight checks for a fresh install: config, MCP server, LLM, tool calling, graphify.

    uv run openpapers-doctor
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

from langchain_core.messages import HumanMessage
from langchain_core.tools import StructuredTool
from pydantic import BaseModel

from .config import Settings, load_settings
from .llm import LLM, content_text
from .openpapers import OpenPapersBridge
from .grounding import resolve_checkers
from .tracing import tracing_status

OK, FAIL, WARN = "[ ok ]", "[FAIL]", "[warn]"


class _EchoArgs(BaseModel):
    word: str


async def _echo(word: str) -> str:
    return word


def _line(status: str, check: str, detail: str = "") -> bool:
    print(f"{status} {check}{': ' + detail if detail else ''}")
    return status != FAIL


async def run_checks() -> bool:
    try:
        settings: Settings = load_settings()
    except RuntimeError as exc:
        return _line(FAIL, "configuration", str(exc))
    cfg = settings.llm
    _line(OK, "configuration", f"model={cfg.model} endpoint={cfg.base_url or 'native LangChain'} key={'set' if cfg.api_key else 'not set'} reasoning={cfg.reasoning}")
    healthy = True

    server = Path(settings.server_command[-1]) if settings.server_command else None
    if server and server.suffix == ".js" and not server.exists():
        healthy = _line(FAIL, "OpenPapers build", f"{server} missing - run `npm ci && npm run build` in the OpenPapers root")
    else:
        try:
            start = time.time()
            async with OpenPapersBridge(settings) as bridge:
                count = len(bridge._tools)
            needed = {"search_papers", "read_paper", "search_within_paper", "extract_paper_facts"}
            missing = needed - set(bridge._tools)
            healthy &= _line(FAIL if missing else OK, "OpenPapers MCP handshake", f"{count} tools in {time.time() - start:.1f}s" + (f", missing {sorted(missing)}" if missing else ""))
        except Exception as exc:  # noqa: BLE001
            healthy = _line(FAIL, "OpenPapers MCP handshake", f"{type(exc).__name__}: {exc}")

    llm = LLM(settings)
    try:
        start = time.time()
        reply = await llm.ainvoke("planner", [HumanMessage(content="Reply with exactly the word OK.")])
        healthy &= _line(OK, "LLM reachable", f"{time.time() - start:.1f}s, replied {content_text(reply).strip()[:40]!r}")
        tool = StructuredTool.from_function(coroutine=_echo, name="echo", description="Echo a word back.", args_schema=_EchoArgs)
        start = time.time()
        reply = await llm.ainvoke("researcher", [HumanMessage(content="Call the echo tool with the word 'papers'. Do not answer in text.")], tools=[tool])
        if reply.tool_calls:
            _line(OK, "tool calling", f"{time.time() - start:.1f}s, called {reply.tool_calls[0]['name']}({reply.tool_calls[0]['args']})")
        else:
            healthy = _line(FAIL, "tool calling", "model answered without calling the tool; researchers need a tool-calling model")
    except Exception as exc:  # noqa: BLE001
        healthy = _line(FAIL, "LLM reachable", f"{type(exc).__name__}: {str(exc)[:300]}")
    finally:
        await llm.aclose()

    try:
        import graphify  # noqa: F401

        _line(OK, "graphify", "knowledge graphs enabled")
    except ImportError:
        _line(WARN, "graphify", "not installed; runs still work, graphs are skipped (`uv sync` installs it)")

    names, problems = resolve_checkers()
    if names:
        _line(OK, "grounding", f"independent checkers: {', '.join(names)} (loaded lazily during citation check)")
    else:
        _line(WARN, "grounding", "; ".join(problems) or "no independent checkers; LLM verifier only (`uv sync --extra grounding`)")
    status = tracing_status()
    _line(OK if status.startswith("on") else WARN, "tracing", f"Langfuse {status}")
    return healthy


def main() -> int:
    healthy = asyncio.run(run_checks())
    print("\nReady." if healthy else "\nFix the failed checks above, then re-run `uv run openpapers-doctor`.")
    return 0 if healthy else 1


if __name__ == "__main__":
    sys.exit(main())
