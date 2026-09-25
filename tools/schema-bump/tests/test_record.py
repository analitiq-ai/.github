"""A bump record carries the cascade's decision and verifies offline against the
schemas it publishes; nothing here calls the network."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from schema_bump import cascade
from schema_bump.diff import diff, diff_sha256
from schema_bump.record import NoChange, decide_record, record_problem

FIXTURES = Path(__file__).parent / "fixtures"
OLD = {"$id": "o", "version": "1.0.0", "type": "object", "properties": {"a": {"type": "string"}}}
NEW = {**OLD, "$id": "n", "required": ["a"]}


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def _jev(choice: str, confidence: float = 0.93) -> tuple[str, int, dict]:
    body = _fixture("jev_answer")
    body["answers"]["bump"].update(choice=choice, confidence=confidence)
    return cascade.JEV_URL, 200, body


def _luna(bump: str) -> tuple[str, int, dict]:
    body = _fixture("luna_answer")
    body["choices"][0]["message"]["content"] = json.dumps({"reasoning": "r", "bump": bump})
    return cascade.CHAT_URL, 200, body


def confident(choice: str) -> list:
    return [_jev(choice)]


def below_the_floor(bump: str) -> list:
    return [_jev("patch", 0.5), _luna(bump)]


def oversized(bump: str) -> list:
    return [(cascade.JEV_URL, 400, _fixture("jev_oversized")), _luna(bump)]


def answering(responses: list):
    """A `Post` answering each queued (url, status, body) in turn."""
    queue = list(responses)

    def post(url, payload):
        expected_url, status, body = queue.pop(0)
        assert url == expected_url
        return status, body

    return post


def _refusing(url, payload):
    pytest.fail("no model call expected")


def _decide(answers: list, override: dict | None = None) -> dict:
    record, _ = decide_record("probe", "1.0.0", OLD, NEW, answering(answers), override)
    return record


def _problem(record: dict, to_version: str | None = None, new: dict = NEW) -> str | None:
    return record_problem(record, "probe", "1.0.0", to_version or record["to"], OLD, new)


def test_a_confident_decision_is_recorded_and_verifies():
    record = _decide(confident("major"))
    assert record == {
        "resource": "probe",
        "from": "1.0.0",
        "to": "2.0.0",
        "diff_sha256": diff_sha256(diff(OLD, NEW)),
        "stage1": {
            "model": "typesafe/jev-1.13-20260917",
            "choice": "major",
            "confidence": 0.93,
            "probabilities": {"major": 0.05, "minor": 0.93, "patch": 0.02},
        },
        "stage2": None,
        "override": None,
        "final": "major",
    }
    assert _problem(record) is None


@pytest.mark.parametrize("answers", [below_the_floor, oversized])
def test_an_escalated_decision_is_recorded_and_verifies(answers):
    record = _decide(answers("minor"))
    assert record["stage2"] == {"model": "openai/gpt-6-luna-20260801", "bump": "minor", "reasoning": "r"}
    assert (record["final"], record["to"]) == ("minor", "1.1.0")
    assert _problem(record) is None


@pytest.mark.parametrize(("models_say", "override", "version"), [("minor", "major", "2.0.0"), ("major", "minor", "1.1.0")])
def test_an_override_wins_in_either_direction_and_keeps_the_model_output(models_say, override, version):
    record = _decide(confident(models_say), {"bump": override, "reason": "policy call"})
    assert record["override"] == {"bump": override, "reason": "policy call"}
    assert (record["final"], record["to"]) == (override, version)
    assert record["stage1"]["choice"] == models_say
    assert _problem(record) is None


@pytest.mark.parametrize(
    "override",
    [{"bump": "major", "reason": None}, {"bump": None, "reason": "why"}, {"bump": "major", "reason": " "}],
    ids=["no-reason", "no-bump", "blank-reason"],
)
def test_an_override_a_record_cannot_carry_is_refused_before_any_call(override):
    with pytest.raises(ValueError):
        decide_record("probe", "1.0.0", OLD, NEW, _refusing, override)


def test_a_change_only_to_the_stamps_is_no_change():
    with pytest.raises(NoChange):
        decide_record("probe", "1.0.0", OLD, {**OLD, "$id": "x", "version": "9.9.9"}, _refusing)


def test_a_record_for_a_schema_edited_afterwards_fails():
    record = _decide(confident("major"))
    assert "different diff" in _problem(record, new={**NEW, "required": ["b"]})


def test_a_record_for_other_versions_fails():
    record = _decide(confident("major"))
    assert _problem(record, to_version="3.0.0") is not None


def test_a_final_that_does_not_advance_to_the_version_fails():
    record = _decide(confident("major"))
    record.update(final="minor", stage1={**record["stage1"], "choice": "minor"})
    assert _problem(record, to_version="2.0.0") is not None


def test_a_final_that_disagrees_with_the_stages_fails():
    record = _decide(confident("major"))
    record["stage1"] = {**record["stage1"], "choice": "minor"}
    assert _problem(record) is not None


def test_a_record_for_another_resource_fails():
    record = _decide(confident("major"))
    assert record_problem(record, "other", "1.0.0", "2.0.0", OLD, NEW) is not None


def _stage1(record: dict, **fields) -> dict:
    return {"stage1": {**record["stage1"], **fields}}


def _stage2(record: dict, **fields) -> dict:
    return {"stage2": {**record["stage2"], **fields}}


@pytest.mark.parametrize(
    ("answers", "edit"),
    [
        pytest.param(confident("major"), lambda r: _stage1(r, confidence=0.05), id="sub-floor-stage1-not-escalated"),
        pytest.param(
            confident("major"), lambda r: {"stage2": {"model": "m", "bump": "major", "reasoning": "r"}},
            id="confident-stage1-escalated",
        ),
        pytest.param(oversized("major"), lambda r: _stage2(r, model=None), id="stage2-without-model"),
        pytest.param(oversized("major"), lambda r: _stage2(r, reasoning=None), id="stage2-without-reasoning"),
        pytest.param(oversized("major"), lambda r: {"stage2": None}, id="skipped-stage1-not-escalated"),
        pytest.param(below_the_floor("major"), lambda r: _stage1(r, confidence=1.5), id="confidence-out-of-range"),
        pytest.param(confident("major"), lambda r: _stage1(r, extra=1), id="stage1-extra-key"),
        pytest.param(
            confident("major"), lambda r: {"override": {"bump": "major", "reason": " "}}, id="blank-override-reason",
        ),
        pytest.param(confident("major"), lambda r: {"extra": 1}, id="record-extra-key"),
    ],
)
def test_a_record_the_cascade_could_not_have_produced_fails(answers, edit):
    record = _decide(answers)
    record.update(edit(record))
    assert _problem(record) is not None
