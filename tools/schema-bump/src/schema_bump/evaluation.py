"""Measure the cascade against labelled corpora. Paid; run by hand.

Two corpora:

- **historical**: every consecutive pair of pinned versions in a history tree
  (`<history>/<resource>/X.Y.Z.json`), labelled by its published bump unless a
  labels file says otherwise;
- **synthetic**: the pairs in `schema_bump.synthetic`, each with a known bump.

A run reports accuracy, under-bumps, escalation rate, cost and the confidence of
every miss. It fails on any under-bump, or on any stage-1 miss at or above the
floor. Changing a model pin, the floor or any prompt text in `cascade` is a
change this evaluation must be re-run for.
"""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import cascade
from .diff import diff
from .semver import BUMPS, SEMVER_RE, bump_between, parse_semver
from .synthetic import PAIRS as SYNTHETIC_PAIRS

_RANK = {bump: rank for rank, bump in enumerate(reversed(BUMPS), start=1)}


@dataclass(frozen=True)
class Case:
    corpus: str
    name: str
    old: dict
    new: dict
    label: str


def historical_cases(history: Path, labels_path: Path | None) -> list[Case]:
    """Every consecutive pinned pair under `history`, labelled; pairs labelled null are left out.

    The labels file is `{"pairs": [{"resource", "from", "to", "label"}, ...]}`,
    each label one of `BUMPS` or null. Naming a pair twice, or a pair that is
    not consecutive in the tree, is an error, so a stale label cannot silently
    stop applying. So is a pair with nothing to classify: every case is checked
    here, before the paid run starts.
    """
    labels = _load_labels(labels_path) if labels_path is not None else {}
    cases: list[Case] = []
    seen: set[tuple[str, str, str]] = set()
    for directory in sorted(p for p in history.iterdir() if p.is_dir()):
        versions = sorted(
            (f.stem for f in directory.glob("*.json") if SEMVER_RE.match(f.stem)), key=parse_semver
        )
        for old_version, new_version in zip(versions, versions[1:]):
            key = (directory.name, old_version, new_version)
            seen.add(key)
            label = labels.get(key, bump_between(old_version, new_version))
            if label is None:
                continue
            old = json.loads((directory / f"{old_version}.json").read_text())
            new = json.loads((directory / f"{new_version}.json").read_text())
            if not diff(old, new):
                raise ValueError(f"{directory.name} {old_version}→{new_version} has nothing to classify; label it null")
            cases.append(Case("historical", f"{directory.name} {old_version}→{new_version}", old, new, label))
    stale = sorted(set(labels) - seen)
    if stale:
        raise ValueError(f"the labels file names pairs that are not consecutive pinned versions: {stale}")
    return cases


_LABEL_KEYS = frozenset({"resource", "from", "to", "label"})


def _load_labels(path: Path) -> dict[tuple[str, str, str], str | None]:
    document = json.loads(path.read_text())
    pairs = document.get("pairs") if isinstance(document, dict) else None
    if not isinstance(pairs, list):
        raise ValueError(f"{path}: not an object with a `pairs` list")
    labels: dict[tuple[str, str, str], str | None] = {}
    for entry in pairs:
        if not isinstance(entry, dict) or entry.keys() != _LABEL_KEYS:
            raise ValueError(f"{path}: a label needs exactly the keys {sorted(_LABEL_KEYS)}: {entry!r}")
        if entry["label"] is not None and entry["label"] not in BUMPS:
            raise ValueError(f"{path}: label {entry['label']!r} is not one of {BUMPS} or null")
        key = (entry["resource"], entry["from"], entry["to"])
        if key in labels:
            raise ValueError(f"{path}: {key} is labelled more than once")
        labels[key] = entry["label"]
    return labels


def synthetic_cases() -> list[Case]:
    return [Case("synthetic", pair.name, pair.old, pair.new, pair.label) for pair in SYNTHETIC_PAIRS]


def score(case: Case, post: cascade.Post) -> dict:
    text = diff(case.old, case.new)
    if not text:
        raise ValueError(f"{case.corpus}: {case.name} has an empty diff; label it null or remove it")
    decision = cascade.decide(case.name, case.old, case.new, text, post)
    stage1 = decision.stage1
    return {
        "corpus": case.corpus,
        "name": case.name,
        "label": case.label,
        "final": decision.final,
        "stage1": stage1,
        "escalated": decision.stage2 is not None,
        "cost": decision.cost,
        "stage1_confident_miss": cascade.stage1_is_final(stage1) and stage1["choice"] != case.label,
    }


def report(run: int, results: list[dict], out: Callable[[str], None] = print) -> bool:
    """Print one run's summary; True when it meets the acceptance bars."""
    ok = True
    for corpus in sorted({r["corpus"] for r in results}):
        rows = [r for r in results if r["corpus"] == corpus]
        misses = [r for r in rows if r["final"] != r["label"]]
        under = [r for r in misses if _RANK[r["final"]] < _RANK[r["label"]]]
        confident = [r for r in rows if r["stage1_confident_miss"]]
        escalated = sum(r["escalated"] for r in rows)
        out(
            f"run {run} {corpus}: {len(rows) - len(misses)}/{len(rows)} correct, "
            f"{len(under)} under-bumps, {escalated}/{len(rows)} escalated, "
            f"${sum(r['cost'] for r in rows):.4f}"
        )
        for r in misses:
            kind = "UNDER" if r in under else "over"
            confidence = r["stage1"].get("confidence", r["stage1"].get("skipped"))
            out(f"    {kind}: {r['name']}: {r['final']} (label {r['label']}; stage 1 {confidence})")
        for r in confident:
            out(f"    STAGE-1 MISS AT/ABOVE FLOOR: {r['name']}: {r['stage1']}")
        ok = ok and not under and not confident
    return ok


def run(cases: list[Case], post: cascade.Post, runs: int, workers: int) -> tuple[bool, list[list[dict]]]:
    """Score every case `runs` times; the verdict and every scored result."""
    all_results: list[list[dict]] = []
    ok = True
    for number in range(1, runs + 1):
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(lambda case: score(case, post), cases))
        all_results.append(results)
        ok = report(number, results) and ok
    return ok, all_results
