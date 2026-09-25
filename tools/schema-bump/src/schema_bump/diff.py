"""The diff between two versions of one schema.

The diff is the evidence the bump models classify and the value a bump record
is hashed over. It is a plain unified diff of the two schemas printed with
sorted keys, `$id` and `version` removed: no JSON-aware matching, so every
other change is in it and nothing decides what counts as a change. Its format
is part of the record contract — a record verifies only against the format it
was hashed over.
"""
from __future__ import annotations

import difflib
import hashlib
import json

# Keys stamped per publication; they differ between any two versions.
STAMP_KEYS = frozenset({"$id", "version"})


def diff(old: dict, new: dict) -> str:
    """The unified diff from `old` to `new`, stamps excluded; empty when equal."""
    return "\n".join(difflib.unified_diff(_text(old), _text(new), "old", "new", lineterm=""))


def diff_sha256(text: str) -> str:
    """The digest a bump record pins its diff by."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def unstamped(schema: dict) -> dict:
    return {k: v for k, v in schema.items() if k not in STAMP_KEYS}


def _text(schema: dict) -> list[str]:
    return json.dumps(unstamped(schema), ensure_ascii=False, indent=2, sort_keys=True).splitlines()
