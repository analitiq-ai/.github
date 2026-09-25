"""The `schema-bump` command line; nothing here calls the network."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from test_record import NEW, OLD, answering, confident

from schema_bump import cascade, cli, evaluation


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


@pytest.mark.parametrize("content", [b"\xff\xfe not utf-8", b"{not json", b"[]"])
def test_an_unreadable_schema_is_refused_with_its_reason_before_any_call(files, models, capsys, content):
    Path(files["old"]).write_bytes(content)
    with pytest.raises(SystemExit) as exit_:
        _decide(files)
    assert exit_.value.code == 2
    assert f"{files['old']}: " in capsys.readouterr().err


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
    labels = tmp_path / "labels.json"
    labels.write_text(json.dumps({"pairs": []}))
    with pytest.raises(SystemExit) as refused:
        cli.main(["eval", "--labels", str(labels)])
    assert refused.value.code == 2


@pytest.mark.parametrize("version", ["1.0", "v1.0.0", "latest"])
def test_decide_refuses_a_version_that_is_not_semver_before_any_call(files, monkeypatch, version):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(cascade, "openrouter_post", lambda api_key: pytest.fail("no call expected"))
    with pytest.raises(SystemExit) as refused:
        cli.main(["decide", "--resource", "probe", "--from-version", version,
                  "--old", files["old"], "--new", files["new"]])
    assert refused.value.code == 2


@pytest.mark.parametrize("flag", ["--from-version", "--to-version"])
def test_verify_refuses_a_version_that_is_not_semver(files, tmp_path, flag):
    record = tmp_path / "record.json"
    record.write_text("{}")
    versions = {"--from-version": "1.0.0", "--to-version": "1.1.0", flag: "1.1"}
    argv = ["verify", "--record", str(record), "--resource", "probe", "--old", files["old"], "--new", files["new"]]
    with pytest.raises(SystemExit) as refused:
        cli.main([*argv, *(arg for pair in versions.items() for arg in pair)])
    assert refused.value.code == 2


def test_eval_refuses_a_history_that_is_not_a_directory(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(cascade, "openrouter_post", lambda api_key: pytest.fail("no call expected"))
    with pytest.raises(SystemExit) as refused:
        cli.main(["eval", "--history", str(tmp_path / "missing")])
    assert refused.value.code == 2


def test_eval_refuses_a_labels_file_that_does_not_exist(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(cascade, "openrouter_post", lambda api_key: pytest.fail("no call expected"))
    with pytest.raises(SystemExit) as refused:
        cli.main(["eval", "--history", str(tmp_path), "--labels", str(tmp_path / "missing.json")])
    assert refused.value.code == 2


def test_eval_refuses_an_out_file_in_a_missing_directory_before_any_call(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(cascade, "openrouter_post", lambda api_key: pytest.fail("no call expected"))
    with pytest.raises(SystemExit) as refused:
        cli.main(["eval", "--out", str(tmp_path / "missing" / "results.json")])
    assert refused.value.code == 2


def test_eval_exits_2_when_the_results_cannot_be_written(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(cascade, "openrouter_post", lambda api_key: None)
    monkeypatch.setattr(evaluation, "run", lambda *a: (True, []))
    out = tmp_path / "results.json"
    out.mkdir()
    assert cli.main(["eval", "--out", str(out)]) == 2


def test_eval_exits_2_on_a_corpus_it_cannot_load(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(cascade, "openrouter_post", lambda api_key: pytest.fail("no call expected"))
    labels = tmp_path / "labels.json"
    labels.write_text(json.dumps({"pairs": [{"resource": "a", "from": "1.0.0", "to": "9.0.0", "label": "major"}]}))
    assert cli.main(["eval", "--history", str(tmp_path), "--labels", str(labels)]) == 2


def test_eval_exits_2_when_a_case_cannot_be_classified(models):
    models.extend((cascade.JEV_URL, 503, {}) for _ in range(1000))
    assert cli.main(["eval", "--runs", "1", "--workers", "1"]) == 2
