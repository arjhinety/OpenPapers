"""Optional Langfuse tracing: every graph node, LLM call and tool call as nested spans, with the
run's gate metrics attached as trace scores.

Enabled when LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set (plus LANGFUSE_HOST /
LANGFUSE_BASE_URL for self-hosted) and `uv sync --extra tracing` installed the SDK. Otherwise
every call here is a no-op, so tracing can never break a research run.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator

SCORED_METRICS = (
    ("evidence_recorded", lambda m: m.get("evidence_recorded")),
    ("evidence_rejected", lambda m: m.get("evidence_rejected")),
    ("supported_rate_before_repair", lambda m: (m.get("citation_check_before") or {}).get("supported_rate")),
    ("supported_rate_after_repair", lambda m: (m.get("citation_check_after") or {}).get("supported_rate")),
    ("grounding_agreement", lambda m: (m.get("grounding") or {}).get("agreement_rate")),
    ("hard_gate_failures", lambda m: (m.get("gate") or {}).get("hard_failures")),
    ("ship", lambda m: m.get("ship")),
    ("cost_usd_reported", lambda m: m.get("cost_usd_reported")),
)


@dataclass
class Trace:
    callbacks: list[Any] = field(default_factory=list)
    trace_id: str | None = None
    _client: Any = None

    @property
    def enabled(self) -> bool:
        return self._client is not None

    def score(self, metrics: dict[str, Any]) -> int:
        if not self.enabled or not self.trace_id:
            return 0
        sent = 0
        for name, pick in SCORED_METRICS:
            value = pick(metrics)
            if value is None:
                continue
            try:
                self._client.create_score(trace_id=self.trace_id, name=name, value=float(value) if not isinstance(value, bool) else value)
                sent += 1
            except Exception:  # noqa: BLE001 - observability must not fail the run
                continue
        return sent


def tracing_status() -> str:
    if not (os.getenv("LANGFUSE_PUBLIC_KEY") and os.getenv("LANGFUSE_SECRET_KEY")):
        return "off (set LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY to enable)"
    try:
        import langfuse  # noqa: F401
        from langfuse.langchain import CallbackHandler  # noqa: F401  (needs the `langchain` package too)
    except ImportError as exc:
        return f"off (keys set but SDK incomplete: {exc}; run uv sync --extra tracing)"
    return f"on ({os.getenv('LANGFUSE_HOST') or os.getenv('LANGFUSE_BASE_URL') or 'Langfuse Cloud'})"


@contextmanager
def trace_run(name: str, metadata: dict[str, Any]) -> Iterator[Trace]:
    if not tracing_status().startswith("on"):
        yield Trace()
        return
    from langfuse import get_client
    from langfuse.langchain import CallbackHandler

    client = get_client()
    try:
        with client.start_as_current_observation(name=name) as span:
            try:
                span.update_trace(name="openpapers-research", metadata=metadata, tags=[str(metadata.get("tier", "")), str(metadata.get("model", ""))])
            except Exception:  # noqa: BLE001 - older SDKs lack update_trace
                pass
            yield Trace(callbacks=[CallbackHandler()], trace_id=span.trace_id, _client=client)
    finally:
        client.flush()
