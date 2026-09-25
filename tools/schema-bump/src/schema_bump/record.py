"""The bump record: one published version's decision, verifiable offline.

A record is written when a version is published and committed beside it. It
pins the diff it was decided on by digest, so it verifies only against the
exact pair of schemas it names, and it carries every model answer and any
override, so the decision can be read back after the fact.
"""
from __future__ import annotations

from typing import Any

from . import cascade
from .diff import diff, diff_sha256
from .semver import bump_version

RECORD_KEYS = frozenset({"resource", "from", "to", "diff_sha256", "stage1", "stage2", "override", "final"})


class NoChange(ValueError):
    """The two schemas differ only in their stamps; there is nothing to decide."""


def decide_record(
    resource: str,
    from_version: str,
    old: dict,
    new: dict,
    post: cascade.Post,
    override: dict | None = None,
) -> tuple[dict, float]:
    """Classify `old` → `new` and return the record publishing it, with the models' cost.

    An override is validated before any model is called.
    """
    if override is not None and (problem := cascade.override_problem(override)):
        raise ValueError(problem)
    text = diff(old, new)
    if not text:
        raise NoChange(f"{resource}: nothing changed since {from_version}")
    decision = cascade.decide(resource, old, new, text, post)
    final = cascade.routed_bump(decision.stage1, decision.stage2, override)
    record = {
        "resource": resource,
        "from": from_version,
        "to": bump_version(from_version, final),
        "diff_sha256": diff_sha256(text),
        "stage1": decision.stage1,
        "stage2": decision.stage2,
        "override": override,
        "final": final,
    }
    return record, decision.cost


def record_problem(
    record: Any, resource: str, from_version: str, to_version: str, old: dict, new: dict
) -> str | None:
    """Why `record` does not justify publishing `new` as `to_version` over `old`
    at `from_version`; None when it does."""
    if not isinstance(record, dict) or record.keys() != RECORD_KEYS:
        return f"is not a bump record (keys must be exactly {sorted(RECORD_KEYS)})"
    if record["resource"] != resource:
        return f"names resource {record['resource']!r}, not {resource!r}"
    if (record["from"], record["to"]) != (from_version, to_version):
        return f"records {record['from']} → {record['to']}, not {from_version} → {to_version}"
    if record["diff_sha256"] != diff_sha256(diff(old, new)):
        return "was written for a different diff; a schema changed after the record was written"
    problem = cascade.decision_problem(record["stage1"], record["stage2"], record["override"], record["final"])
    if problem:
        return problem
    if bump_version(from_version, record["final"]) != to_version:
        return f"has final {record['final']!r}, which does not advance {from_version} to {to_version}"
    return None
