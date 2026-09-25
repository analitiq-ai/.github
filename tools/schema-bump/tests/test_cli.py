"""The `schema-bump` command line; nothing here calls the network."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from schema_bump import cascade, cli, evaluation
from test_record import NEW, OLD, answering, confident


@pytest.fixture
def files(tmp_path) -> dict[str, str]:
    paths = {}
    for name, doc in (("old", OLD), ("new", NEW)):
        path = tmp_path / f"{name}.json"
        path.write_text(json.dumps(doc))
        paths[name] = str(path)
    return paths


@pytest.fixture
def models(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    responses: list = []
    monkeypatch.setattr(cascade, "openrouter_post", lambda api_key: answering(responses))
    return responses


def _decide(files, *extra: str) -> int:
    return cli.main(["decide", "--resource", "probe", "--from-version", "1.0.0",
                     "--old", files["old"], "--new", files["new"], *extra])


def test_decide_prints_a_record_that_verify_accepts(files, models, capsys, tmp_path):
    models.extend(confident("minor"))
    assert _decide(files) == 0
    record = tmp_path / "record.json"
    record.write_text(capsys.readouterr().out)
    assert json.loads(record.read_text())["to"] == "1.1.0"
    argv = ["verify", "--record", str(record), "--resource", "probe", "--from-version", "1.0.0",
            "--old", files["old"], "--new", files["new"]]
    assert cli.main([*argv, "--to-version", "1.1.0"]) == 0
    assert cli.main([*argv, "--to-version", "2.0.0"]) == 1


def test_decide_exits_3_when_nothing_changed(files, models):
    files["new"] = files["old"]
    assert _decide(files) == 3


@pytest.mark.parametrize("extra", [["--bump", "major"], ["--reason", "why"], ["--bump", "major", "--reason", " "]])
def test_decide_refuses_an_override_it_cannot_record_before_any_call(files, models, extra):
    assert _decide(files, *extra) == 2


def test_decide_without_a_key_fails(files, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    assert _decide(files) == 2


def test_a_failed_classification_fails(files, models):
    models.append((cascade.JEV_URL, 503, {}))
    assert _decide(files) == 2


@pytest.mark.parametrize("flag", ["--runs", "--workers"])
@pytest.mark.parametrize("count", ["0", "-1"])
def test_eval_refuses_a_count_below_one_before_any_call(monkeypatch, flag, count):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(cascade, "openrouter_post", lambda api_key: pytest.fail("no call expected"))
    with pytest.raises(SystemExit) as refused:
        cli.main(["eval", flag, count])
    assert refused.value.code == 2


def test_eval_refuses_labels_without_a_history(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(evaluation, "run", lambda *a: pytest.fail("no run expected"))
    with pytest.raises(SystemExit) as refused:
        cli.main(["eval", "--labels", str(tmp_path / "labels.json")])
    assert refused.value.code == 2
