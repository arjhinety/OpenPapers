"""Provider-agnostic LLM access: model factory, JSON-with-repair, usage accounting, tool loop."""

from __future__ import annotations

import asyncio
import json
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable, TypeVar

import httpx
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool
from pydantic import BaseModel, ValidationError

from .config import Settings

T = TypeVar("T", bound=BaseModel)


# --- gateway compatibility -------------------------------------------------------------------


def unwrap_envelope(body: bytes) -> bytes | None:
    """Return the inner completion if a gateway wrapped it as {"data": {...}}, else None."""
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict) or "choices" in payload:
        return None
    inner = payload.get("data")
    if isinstance(inner, dict) and ("choices" in inner or inner.get("object") == "chat.completion"):
        return json.dumps(inner).encode()
    return None


def _rebuild(response: httpx.Response, body: bytes, request: httpx.Request) -> httpx.Response:
    headers = [(k, v) for k, v in response.headers.multi_items() if k.lower() not in {"content-length", "content-encoding"}]
    return httpx.Response(response.status_code, headers=headers, content=body, request=request)


class EnvelopeUnwrapTransport(httpx.AsyncBaseTransport):
    """Lets standard OpenAI clients talk to gateways (e.g. Cline) that envelope responses."""

    def __init__(self, inner: httpx.AsyncBaseTransport | None = None) -> None:
        self._inner = inner or httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        response = await self._inner.handle_async_request(request)
        if "json" not in response.headers.get("content-type", ""):
            return response
        body = await response.aread()
        await response.aclose()
        return _rebuild(response, unwrap_envelope(body) or body, request)

    async def aclose(self) -> None:
        await self._inner.aclose()


# --- text helpers ------------------------------------------------------------------------------

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def content_text(message: BaseMessage | str) -> str:
    if isinstance(message, str):
        return message
    content = message.content
    if isinstance(content, str):
        return content
    parts = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "".join(parts)


def strip_reasoning(text: str) -> str:
    """Drop inline chain-of-thought some reasoning models emit in `content`."""
    text = _THINK_RE.sub("", text)
    if "</think>" in text.lower():  # opening tag lost, keep what follows the close
        text = re.split(r"</think>", text, flags=re.IGNORECASE)[-1]
    return text.strip()


def extract_json(text: str) -> Any:
    """Parse the first JSON object/array in model output (fenced or bare)."""
    text = strip_reasoning(text)
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    candidates = [fenced.group(1)] if fenced else []
    candidates.append(text)
    for candidate in candidates:
        candidate = candidate.strip()
        try:
            return json.loads(candidate)
        except ValueError:
            pass
        span = _balanced_span(candidate)
        if span:
            try:
                return json.loads(span)
            except ValueError:
                continue
    raise ValueError("no parseable JSON object in model output")


def _balanced_span(text: str) -> str | None:
    start = next((i for i, ch in enumerate(text) if ch in "{["), None)
    if start is None:
        return None
    opener = text[start]
    closer = "}" if opener == "{" else "]"
    depth, in_string, escaped = 0, False, False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


# --- usage accounting --------------------------------------------------------------------------


@dataclass
class Usage:
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    by_role: dict[str, int] = field(default_factory=lambda: defaultdict(int))

    def record(self, role: str, message: AIMessage) -> None:
        self.calls += 1
        self.by_role[role] += 1
        usage = message.usage_metadata or {}
        self.input_tokens += int(usage.get("input_tokens", 0) or 0)
        self.output_tokens += int(usage.get("output_tokens", 0) or 0)
        raw = (message.response_metadata or {}).get("token_usage") or {}
        cost = raw.get("cost") if isinstance(raw, dict) else None
        if isinstance(cost, (int, float)):
            self.cost_usd += float(cost)

    def as_dict(self) -> dict[str, Any]:
        return {
            "llm_calls": self.calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd_reported": round(self.cost_usd, 6),
            "calls_by_role": dict(self.by_role),
        }


# --- model gateway -----------------------------------------------------------------------------


class LLM:
    """One gateway for every role: per-role model overrides, bounded concurrency, usage totals."""

    def __init__(self, settings: Settings, models: dict[str, BaseChatModel] | None = None) -> None:
        self.settings = settings
        self.usage = Usage()
        self._models: dict[str, BaseChatModel] = dict(models or {})
        self._sem = asyncio.Semaphore(settings.llm_concurrency)
        self._http: httpx.AsyncClient | None = None

    def model(self, role: str) -> BaseChatModel:
        name = self.settings.model_for(role)
        if name not in self._models:
            self._models[name] = self._build(name)
        return self._models[name]

    def _build(self, name: str) -> BaseChatModel:
        cfg = self.settings.llm
        extra: dict[str, Any] = {} if cfg.reasoning else {"temperature": 0.2}
        if cfg.base_url:
            from langchain_openai import ChatOpenAI

            if self._http is None:
                self._http = httpx.AsyncClient(transport=EnvelopeUnwrapTransport(), timeout=cfg.timeout)
            return ChatOpenAI(
                model=name,
                base_url=cfg.base_url,
                api_key=cfg.api_key,
                timeout=cfg.timeout,
                max_retries=cfg.max_retries,
                http_async_client=self._http,
                **extra,
            )
        try:
            from langchain.chat_models import init_chat_model
        except ImportError as exc:  # pragma: no cover - depends on optional install
            raise RuntimeError(
                "Set OPA_BASE_URL for an OpenAI-compatible endpoint, or install `langchain` and the "
                "provider package to use native 'provider:model' ids."
            ) from exc
        return init_chat_model(name, **extra)

    async def ainvoke(self, role: str, messages: list[BaseMessage], tools: list[BaseTool] | None = None) -> AIMessage:
        model = self.model(role)
        runnable = model.bind_tools(tools) if tools else model
        async with self._sem:
            message = await runnable.ainvoke(messages)
        self.usage.record(role, message)
        return message

    async def text(self, role: str, messages: list[BaseMessage]) -> str:
        return strip_reasoning(content_text(await self.ainvoke(role, messages)))

    async def json(
        self,
        role: str,
        messages: list[BaseMessage],
        schema: type[T],
        attempts: int = 3,
        tools: list[BaseTool] | None = None,
    ) -> T:
        """Ask for JSON matching `schema`; feed parse/validation errors back and retry.

        `tools` stays bound when the history already contains tool calls, because some providers
        reject tool-call histories sent without tool definitions.
        """
        history = list(messages)
        last_error = ""
        for _ in range(attempts):
            reply = await self.ainvoke(role, history, tools=tools)
            try:
                return schema.model_validate(extract_json(content_text(reply)))
            except (ValueError, ValidationError) as exc:
                last_error = str(exc)[:1500]
                history += [
                    AIMessage(content=content_text(reply)[:4000]),
                    HumanMessage(content=f"That was not valid JSON for the required schema: {last_error}\nReturn only the corrected JSON object."),
                ]
        raise ValueError(f"{role}: model never produced valid {schema.__name__}: {last_error}")

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()


def schema_hint(schema: type[BaseModel]) -> str:
    return json.dumps(schema.model_json_schema(), separators=(",", ":"))


async def run_tool_agent(
    llm: LLM,
    role: str,
    system: str,
    task: str,
    tools: list[BaseTool],
    schema: type[T],
    max_steps: int = 8,
    on_tool: Callable[[str, dict[str, Any], str], None] | None = None,
) -> tuple[T, int]:
    """Bounded tool-calling loop, then a structured final answer. Returns (answer, tool_calls_made)."""
    by_name = {tool.name: tool for tool in tools}
    messages: list[BaseMessage] = [SystemMessage(content=system), HumanMessage(content=task)]
    calls_made = 0
    last: AIMessage | None = None
    for _ in range(max_steps):
        last = await llm.ainvoke(role, messages, tools=tools)
        messages.append(last)
        if not last.tool_calls:
            break
        for call in last.tool_calls:
            calls_made += 1
            tool = by_name.get(call["name"])
            try:
                output = await tool.ainvoke(call["args"]) if tool else f"ERROR: unknown tool {call['name']!r}"
            except Exception as exc:  # tool errors go back to the model, never crash the run
                output = f"ERROR: {type(exc).__name__}: {exc}"
            if on_tool:
                on_tool(call["name"], call["args"], str(output))
            messages.append(ToolMessage(content=str(output), tool_call_id=call["id"]))
    else:
        last = None  # budget exhausted mid-investigation

    if last is not None and not last.tool_calls:
        try:
            return schema.model_validate(extract_json(content_text(last))), calls_made
        except (ValueError, ValidationError):
            pass
    messages.append(
        HumanMessage(
            content="Stop using tools. Return your final answer now as a single JSON object matching this "
            f"JSON schema, with no prose around it:\n{schema_hint(schema)}"
        )
    )
    return await llm.json(role, messages, schema, tools=tools), calls_made
