"""The evaluation corpora load offline and every scored pair has something to classify.

The evaluation itself is paid and run by hand; a corpus defect found here costs
nothing, where found there it costs a run.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from schema_bump import cascade, evaluation
from schema_bump.diff import diff
from schema_bump.semver import BUMPS
from schema_bump.synthetic import PAIRS as SYNTHETIC_PAIRS

SYNTHETIC = evaluation.synthetic_cases()


@pytest.mark.parametrize("case", SYNTHETIC, ids=[c.name for c in SYNTHETIC])
def test_every_synthetic_pair_differs_and_carries_a_bump_label(case):
    assert case.label in BUMPS
    assert diff(case.old, case.new)


def _pinned(root: Path, resource: str, version: str, **body) -> None:
    path = root / resource / f"{version}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": version, **body}))


@pytest.fixture
def history(tmp_path) -> Path:
    root = tmp_path / "schemas"
    _pinned(root, "a", "1.0.0", type="string")
    _pinned(root, "a", "1.1.0", type=["string", "null"])
    _pinned(root, "a", "2.0.0", type="integer")
    _pinned(root, "b", "1.0.0", type="string")
    (root / "a" / "latest.json").write_text("{}")
    return root


def _labels(tmp_path: Path, *pairs: dict) -> Path:
    path = tmp_path / "labels.json"
    path.write_text(json.dumps({"pairs": list(pairs)}))
    return path


def test_historical_pairs_are_consecutive_pinned_versions_labelled_by_their_bump(history):
    cases = evaluation.historical_cases(history, None)
    assert [(c.name, c.label) for c in cases] == [("a 1.0.0→1.1.0", "minor"), ("a 1.1.0→2.0.0", "major")]


def test_a_label_overrides_the_published_bump_and_null_leaves_the_pair_out(history, tmp_path):
    labels = _labels(
        tmp_path,
        {"resource": "a", "from": "1.0.0", "to": "1.1.0", "label": "major"},
        {"resource": "a", "from": "1.1.0", "to": "2.0.0", "label": None},
    )
    assert [(c.name, c.label) for c in evaluation.historical_cases(history, labels)] == [("a 1.0.0→1.1.0", "major")]


def test_a_label_for_a_pair_that_is_not_consecutive_fails(history, tmp_path):
    labels = _labels(tmp_path, {"resource": "a", "from": "1.0.0", "to": "2.0.0", "label": "major"})
    with pytest.raises(ValueError):
        evaluation.historical_cases(history, labels)


@pytest.mark.parametrize(
    "entry",
    [
        pytest.param({"resource": "a", "from": "1.0.0", "to": "1.1.0", "label": "huge"}, id="label-outside-bumps"),
        pytest.param({"resource": "a", "from": "1.0.0", "to": "1.1.0"}, id="no-label"),
        pytest.param({"resource": "a", "from": "1.0.0", "to": "1.1.0", "label": "minor", "x": 1}, id="extra-key"),
        pytest.param({"resource": ["a"], "from": "1.0.0", "to": "1.1.0", "label": "minor"}, id="resource-not-a-string"),
        pytest.param({"resource": "a", "from": 1, "to": "1.1.0", "label": "minor"}, id="version-not-a-string"),
        pytest.param(
            {"resource": "a", "from": "1.0.0", "to": "1.1.0", "label": "minor", "rationale": 3}, id="rationale-not-a-string",
        ),
    ],
)
def test_a_malformed_label_fails_at_load(history, tmp_path, entry):
    with pytest.raises(ValueError):
        evaluation.historical_cases(history, _labels(tmp_path, entry))


@pytest.mark.parametrize("document", [{}, {"pairs": {}}, []])
def test_a_labels_file_without_a_pairs_list_fails_at_load(history, tmp_path, document):
    path = tmp_path / "labels.json"
    path.write_text(json.dumps(document))
    with pytest.raises(ValueError):
        evaluation.historical_cases(history, path)


def test_a_label_may_carry_its_rationale(history, tmp_path):
    labels = _labels(tmp_path, {"resource": "a", "from": "1.0.0", "to": "1.1.0", "label": "major", "rationale": "why"})
    assert ("a 1.0.0→1.1.0", "major") in [(c.name, c.label) for c in evaluation.historical_cases(history, labels)]


@pytest.mark.parametrize("text", ["{", ""])
def test_a_labels_file_that_is_not_json_fails_at_load(history, tmp_path, text):
    path = tmp_path / "labels.json"
    path.write_text(text)
    with pytest.raises(ValueError):
        evaluation.historical_cases(history, path)


@pytest.mark.parametrize("text", ["{", "[]", "3"])
def test_a_pinned_version_that_is_not_a_json_object_fails_at_load(history, text):
    (history / "a" / "1.1.0.json").write_text(text)
    with pytest.raises(ValueError):
        evaluation.historical_cases(history, None)


def test_an_unreadable_pinned_version_fails_at_load(history):
    path = history / "a" / "1.1.0.json"
    path.unlink()
    path.mkdir()
    with pytest.raises(ValueError):
        evaluation.historical_cases(history, None)


def test_a_pair_labelled_twice_fails_at_load(history, tmp_path):
    entry = {"resource": "a", "from": "1.0.0", "to": "1.1.0", "label": "minor"}
    with pytest.raises(ValueError):
        evaluation.historical_cases(history, _labels(tmp_path, entry, {**entry, "label": "major"}))


@pytest.mark.parametrize("labelled", [False, True], ids=["unlabelled", "labelled"])
@pytest.mark.parametrize(
    "root",
    [
        pytest.param(lambda history: history / "a", id="one-level-too-deep"),
        pytest.param(lambda history: history / "b", id="single-version"),
        pytest.param(lambda history: history.parent / "empty", id="empty"),
    ],
)
def test_a_history_with_no_consecutive_pair_fails_at_load(history, tmp_path, root, labelled):
    (history.parent / "empty").mkdir()
    labels = _labels(tmp_path) if labelled else None
    with pytest.raises(ValueError, match="history"):
        evaluation.historical_cases(root(history), labels)


def test_a_pair_with_nothing_to_classify_fails_at_load(history):
    _pinned(history, "b", "1.0.1", type="string")
    with pytest.raises(ValueError):
        evaluation.historical_cases(history, None)


def _answering(jev_confidence: float):
    luna = {
        "model": "l", "usage": {"cost": 0},
        "choices": [{"finish_reason": "stop", "message": {"content": '{"reasoning":"r","bump":"major"}'}}],
    }

    def post(url, payload):
        if url == cascade.JEV_URL:
            answer = {"choice": "minor", "confidence": jev_confidence, "probabilities": {}}
            return 200, {"model": "j", "answers": {"bump": answer}, "usage": {"cost": 0}}
        return 200, luna

    return post


@pytest.mark.parametrize(("confidence", "counted"), [(cascade.CONFIDENCE_FLOOR, True), (0.69, False)])
def test_a_stage1_miss_counts_against_the_floor_only_when_stage1_was_final(confidence, counted):
    case = evaluation.Case("synthetic", "probe", {"type": "object"}, {"type": "string"}, "major")
    assert evaluation.score(case, _answering(confidence))["stage1_confident_miss"] is counted


@pytest.mark.parametrize(("final", "passes"), [("major", True), ("minor", False)])
def test_a_run_fails_on_an_under_bump(final, passes):
    row = {"corpus": "c", "name": "n", "label": "major", "final": final, "stage1": {"skipped": "x"},
           "escalated": True, "cost": 0, "stage1_confident_miss": False}
    assert evaluation.report(1, [row], out=lambda line: None) is passes


@pytest.mark.parametrize(("confident_miss", "passes"), [(False, True), (True, False)])
def test_a_run_fails_on_a_stage1_miss_at_or_above_the_floor(confident_miss, passes):
    row = {"corpus": "c", "name": "n", "label": "minor", "final": "major", "stage1": {"confidence": 0.9},
           "escalated": False, "cost": 0, "stage1_confident_miss": confident_miss}
    assert evaluation.report(1, [row], out=lambda line: None) is passes


def test_the_looser_retarget_pair_rejects_no_document_its_old_side_accepted():
    from jsonschema import Draft202012Validator

    [pair] = [p for p in SYNTHETIC_PAIRS if p.name == "anyOf branch retargeted to a looser definition"]
    document = {"id": "00000000-0000-0000-0000-000000000000", "kind": "a", "source": {"sql": "x", "dialect": "ansi"}}
    assert Draft202012Validator(pair.old).is_valid(document)
    assert Draft202012Validator(pair.new).is_valid(document)
