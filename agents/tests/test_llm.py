import json

import httpx
import pytest

from openpapers_agents.llm import EnvelopeUnwrapTransport, extract_json, strip_reasoning, unwrap_envelope

COMPLETION = {"id": "x", "object": "chat.completion", "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}]}


def test_unwrap_envelope_only_when_wrapped():
    assert json.loads(unwrap_envelope(json.dumps({"data": COMPLETION}).encode())) == COMPLETION
    assert unwrap_envelope(json.dumps(COMPLETION).encode()) is None
    assert unwrap_envelope(json.dumps({"error": {"message": "bad"}}).encode()) is None
    assert unwrap_envelope(b"not json") is None


async def test_transport_unwraps_gateway_response():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": COMPLETION})

    async with httpx.AsyncClient(transport=EnvelopeUnwrapTransport(httpx.MockTransport(handler))) as client:
        response = await client.post("https://gateway.example/v1/chat/completions", json={})
    assert response.json() == COMPLETION


def test_strip_reasoning():
    assert strip_reasoning("<think>plan a b c</think>\nAnswer") == "Answer"
    assert strip_reasoning("dangling thoughts</think> Answer") == "Answer"


@pytest.mark.parametrize(
    "text",
    [
        '{"a": 1}',
        'Sure:\n```json\n{"a": 1}\n```',
        '<think>{"not": "this"}</think> Here you go {"a": 1} thanks',
        'prefix {"a": 1, "s": "brace } in string"} suffix',
    ],
)
def test_extract_json(text):
    assert extract_json(text)["a"] == 1


def test_extract_json_raises():
    with pytest.raises(ValueError):
        extract_json("no json here")
