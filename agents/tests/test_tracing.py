from openpapers_agents.tracing import Trace, trace_run, tracing_status


def test_tracing_is_a_noop_without_keys(monkeypatch):
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    assert tracing_status().startswith("off")
    with trace_run("x", {}) as trace:
        assert trace.callbacks == [] and not trace.enabled
        assert trace.score({"ship": True}) == 0


class FakeClient:
    def __init__(self):
        self.scores = []

    def create_score(self, **kwargs):
        self.scores.append(kwargs)


def test_scores_skip_missing_metrics_and_keep_booleans():
    client = FakeClient()
    trace = Trace(trace_id="t1", _client=client)
    metrics = {"evidence_recorded": 14, "citation_check_after": {"supported_rate": 1.0}, "gate": {"hard_failures": 0}, "ship": True}
    assert trace.score(metrics) == 4
    by_name = {s["name"]: s["value"] for s in client.scores}
    assert by_name == {"evidence_recorded": 14.0, "supported_rate_after_repair": 1.0, "hard_gate_failures": 0.0, "ship": True}
    assert all(s["trace_id"] == "t1" for s in client.scores)


def test_keys_without_complete_sdk_stay_off(monkeypatch):
    import builtins

    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk")
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name.startswith("langfuse"):
            raise ImportError("No module named 'langchain'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    assert tracing_status().startswith("off (keys set but SDK incomplete")
    with trace_run("x", {}) as trace:  # must degrade to a no-op, never crash the run
        assert not trace.enabled
