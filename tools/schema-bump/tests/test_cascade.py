"""The Jev → Luna cascade, driven by recorded responses; nothing here calls the network."""
from __future__ import annotations

import copy
import io
import json
import http.client
import urllib.error
from pathlib import Path

import pytest

from schema_bump import cascade
from schema_bump.diff import diff

FIXTURES = Path(__file__).parent / "fixtures"
OLD = {"type": "object", "properties": {"a": {"type": "string"}}}
NEW = {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]}


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def _jev(confidence: float) -> dict:
    body = _fixture("jev_answer")
    body["answers"]["bump"]["confidence"] = confidence
    return body


class FakeOpenRouter:
    """Answers each URL with the next queued (status, body); records every request."""

    def __init__(self, **responses: list[tuple[int, dict]]):
        self.queues = {
            cascade.JEV_URL: list(responses.get("jev", [])),
            cascade.CHAT_URL: list(responses.get("luna", [])),
        }
        self.requests: list[tuple[str, dict]] = []

    def __call__(self, url: str, payload: dict) -> tuple[int, dict]:
        self.requests.append((url, copy.deepcopy(payload)))
        return self.queues[url].pop(0)


def _decide(post: FakeOpenRouter) -> cascade.Decision:
    return cascade.decide("probe", OLD, NEW, diff(OLD, NEW), post)


def test_a_confidence_at_the_floor_is_final():
    post = FakeOpenRouter(jev=[(200, _jev(cascade.CONFIDENCE_FLOOR))])
    decision = _decide(post)
    assert decision.final == "minor"
    assert decision.stage2 is None
    assert decision.stage1 == {
        "model": "typesafe/jev-1.13-20260917",
        "choice": "minor",
        "confidence": cascade.CONFIDENCE_FLOOR,
        "probabilities": {"major": 0.05, "minor": 0.93, "patch": 0.02},
    }
    assert [url for url, _ in post.requests] == [cascade.JEV_URL]


def test_a_confidence_below_the_floor_escalates_to_luna():
    post = FakeOpenRouter(jev=[(200, _jev(0.69))], luna=[(200, _fixture("luna_answer"))])
    decision = _decide(post)
    assert decision.final == "major"
    assert decision.stage1["choice"] == "minor"
    assert decision.stage2 == {
        "model": "openai/gpt-6-luna-20260801",
        "bump": "major",
        "reasoning": "A name was added to required, so a document without it is now rejected.",
    }
    assert decision.cost == pytest.approx(0.0000173 + 0.00091)


def test_an_oversized_diff_skips_jev_and_escalates():
    post = FakeOpenRouter(jev=[(400, _fixture("jev_oversized"))], luna=[(200, _fixture("luna_answer"))])
    decision = _decide(post)
    assert decision.stage1 == {"skipped": "max_tokens_exceeded"}
    assert decision.final == "major"


def test_the_requests_carry_the_pins_and_the_prompt_texts():
    post = FakeOpenRouter(jev=[(200, _jev(0.5))], luna=[(200, _fixture("luna_answer"))])
    _decide(post)
    (_, jev), (_, luna) = post.requests
    assert jev["model"] == cascade.JEV_MODEL
    assert jev["state"] == {"resource": "probe", "diff": diff(OLD, NEW)}
    assert jev["questions"]["bump"]["criteria"] == cascade.CRITERIA
    assert luna["model"] == cascade.LUNA_MODEL
    assert luna["max_tokens"] == cascade.LUNA_MAX_TOKENS
    assert luna["usage"] == {"include": True}
    assert luna["response_format"] == cascade.LUNA_RESPONSE_FORMAT
    assert luna["messages"][0] == {"role": "system", "content": cascade.LUNA_SYSTEM}
    assert json.loads(luna["messages"][1]["content"]) == {
        "resource": "probe", "diff": diff(OLD, NEW), "old_schema": OLD, "new_schema": NEW,
    }


def _luna_with(mutate) -> dict:
    body = _fixture("luna_answer")
    mutate(body)
    return body


def _content(text):
    return lambda body: body["choices"][0]["message"].__setitem__("content", text)


@pytest.mark.parametrize(
    "luna",
    [
        pytest.param((500, {"error": {"code": 500, "message": "upstream"}}), id="http-error"),
        pytest.param((200, _luna_with(lambda b: b["choices"][0]["message"].pop("content"))), id="missing-content"),
        pytest.param((200, _luna_with(_content(None))), id="null-content"),
        pytest.param((200, _luna_with(_content(""))), id="empty-content"),
        pytest.param(
            (200, _luna_with(lambda b: b["choices"][0].__setitem__("finish_reason", "length"))), id="truncated",
        ),
        pytest.param((200, _luna_with(_content("major"))), id="not-json"),
        pytest.param((200, _luna_with(_content('{"reasoning":"r","bump":"none"}'))), id="bump-outside-enum"),
        pytest.param((200, _luna_with(_content('{"bump":"major"}'))), id="no-reasoning"),
        pytest.param((200, _luna_with(_content('["major"]'))), id="not-an-object"),
        pytest.param((200, _luna_with(lambda b: b.pop("choices"))), id="no-choices"),
        pytest.param((200, _luna_with(lambda b: b["usage"].__setitem__("cost", "0.01"))), id="cost-not-a-number"),
        pytest.param((200, _luna_with(lambda b: b["usage"].__setitem__("cost", True))), id="cost-a-bool"),
        pytest.param((200, _luna_with(lambda b: b["usage"].__setitem__("cost", -0.01))), id="cost-negative"),
    ],
)
def test_a_malformed_luna_answer_fails_loud(luna):
    post = FakeOpenRouter(jev=[(200, _jev(0.5))], luna=[luna])
    with pytest.raises(cascade.BumpClassificationError):
        _decide(post)


@pytest.mark.parametrize(
    "jev",
    [
        pytest.param((401, {"error": {"code": 401, "message": "no auth"}}), id="http-error"),
        pytest.param((400, {"error": {"code": 400, "message": "bad request"}}), id="other-400"),
        pytest.param((200, {**_jev(0.9), "answers": {}}), id="no-answer"),
        pytest.param(
            (200, {"model": "m", "answers": {"bump": {
                "choice": "none", "confidence": 0.9, "probabilities": {}}}, "usage": {"cost": 0}}),
            id="choice-outside-enum",
        ),
        pytest.param(
            (200, {"model": "m", "answers": {"bump": {
                "choice": "minor", "confidence": 1.5, "probabilities": {}}}, "usage": {"cost": 0}}),
            id="confidence-out-of-range",
        ),
        pytest.param((200, {**_jev(0.9), "usage": {"cost": None}}), id="cost-not-a-number"),
        pytest.param((200, {**_jev(0.9), "usage": {"cost": -0.01}}), id="cost-negative"),
    ],
)
def test_a_failed_jev_call_fails_loud(jev):
    post = FakeOpenRouter(jev=[jev])
    with pytest.raises(cascade.BumpClassificationError):
        _decide(post)


def test_an_empty_diff_is_never_classified():
    with pytest.raises(ValueError):
        cascade.decide("probe", OLD, OLD, "", FakeOpenRouter())


def test_luna_reads_both_whole_schemas_without_their_stamps():
    old = {"$id": "x", "version": "1.0.0", "$ref": "#/$defs/A",
           "$defs": {"A": {"$ref": "#/$defs/B"}, "B": {"type": "string"}, "C": {"type": "integer"}}}
    new = {**old, "version": "2.0.0", "$ref": "#/$defs/C"}
    payload = cascade.stage2_payload("probe", old, new, diff(old, new))
    assert payload == {
        "resource": "probe",
        "diff": diff(old, new),
        "old_schema": {k: v for k, v in old.items() if k not in ("$id", "version")},
        "new_schema": {k: v for k, v in new.items() if k not in ("$id", "version")},
    }


class _Body(io.BytesIO):
    """A response body; `read` raises `failure` when one is given."""

    def __init__(self, raw: bytes, status: int = 200, failure: Exception | None = None):
        super().__init__(raw)
        self.status, self.failure = status, failure

    def read(self, *args):
        if self.failure is not None:
            raise self.failure
        return super().read(*args)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _ok(raw: bytes, failure: Exception | None = None):
    return lambda: _Body(raw, failure=failure)


def _status(code: int, raw: bytes, failure: Exception | None = None):
    def answer():
        raise urllib.error.HTTPError("u", code, "m", {}, _Body(raw, code, failure))

    return answer


def _raises(error: Exception):
    def answer():
        raise error

    return answer


RAISES = object()
JSON = json.dumps({"ok": True}).encode()
OVERSIZED = json.dumps(_fixture("jev_oversized")).encode()
TRIES = len(cascade._RETRY_DELAYS) + 1
NOT_JSON = {"html": b"<html>", "not-utf8": b"\xff"}
DROPPED = {
    "timeout": TimeoutError("read timed out"),
    "reset": ConnectionResetError(),
    "truncated": http.client.IncompleteRead(b"{"),
}


def _wrapped(code: int, raw: bytes) -> dict:
    return {"error": {"message": raw.decode("utf-8", "replace"), "code": code}}


# Every row of the client's behaviour: the answers the server gives in order,
# then what `post` returns (or RAISES, a BumpClassificationError) and how many
# requests it made. A failure is raised by urlopen, by the body read, or by the
# error body read; each surfaces the same way.
TRANSPORT = [
    pytest.param([_ok(JSON)], (200, {"ok": True}), 1, id="success"),
    *(pytest.param([_ok(raw)], RAISES, 1, id=f"success-{name}") for name, raw in NOT_JSON.items()),
    pytest.param([_status(429, b"{}"), _status(529, b"{}"), _ok(JSON)], (200, {"ok": True}), 3, id="retried"),
    pytest.param([_status(503, JSON)] * TRIES, (503, {"ok": True}), TRIES, id="retries-exhausted"),
    *(
        pytest.param([_status(503, raw)] * TRIES, (503, _wrapped(503, raw)), TRIES, id=f"retries-exhausted-{name}")
        for name, raw in NOT_JSON.items()
    ),
    pytest.param([_status(400, OVERSIZED)], (400, _fixture("jev_oversized")), 1, id="client-error"),
    *(pytest.param([_status(400, raw)], (400, _wrapped(400, raw)), 1, id=f"client-error-{name}") for name, raw in NOT_JSON.items()),
    pytest.param([_raises(urllib.error.URLError("no route"))], RAISES, 1, id="unreachable"),
    *(pytest.param([_raises(error)], RAISES, 1, id=f"connect-{name}") for name, error in DROPPED.items()),
    *(pytest.param([_ok(JSON, error)], RAISES, 1, id=f"read-{name}") for name, error in DROPPED.items()),
    *(
        pytest.param([_status(code, JSON, error)], RAISES, 1, id=f"error-read-{code}-{name}")
        for code in (400, 503)
        for name, error in DROPPED.items()
    ),
]


@pytest.mark.parametrize(("answers", "outcome", "requests"), TRANSPORT)
def test_the_client(monkeypatch, answers, outcome, requests):
    calls, slept = [], []

    def urlopen(request, timeout):
        calls.append(request)
        return answers[len(calls) - 1]()

    monkeypatch.setattr(cascade.urllib.request, "urlopen", urlopen)
    post = cascade.openrouter_post("key", sleep=slept.append)
    if outcome is RAISES:
        with pytest.raises(cascade.BumpClassificationError):
            post(cascade.JEV_URL, {})
    else:
        assert post(cascade.JEV_URL, {}) == outcome
    assert len(calls) == requests
    assert len(slept) == requests - 1
    assert all(call.get_header("Authorization") == "Bearer key" for call in calls)
