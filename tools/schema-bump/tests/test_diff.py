"""The text diff the bump models classify and bump records hash."""
from __future__ import annotations

import hashlib

from schema_bump.diff import diff, diff_sha256


def test_the_diff_is_a_unified_diff_of_the_sorted_key_renders():
    old = {"type": "object", "properties": {"a": {"type": "string"}}}
    new = {"properties": {"a": {"type": "integer"}}, "type": "object"}
    assert diff(old, new) == "\n".join([
        "--- old",
        "+++ new",
        "@@ -1,7 +1,7 @@",
        " {",
        '   "properties": {',
        '     "a": {',
        '-      "type": "string"',
        '+      "type": "integer"',
        "     }",
        "   },",
        '   "type": "object"',
    ])


def test_stamps_and_key_order_are_no_change():
    old = {"$id": "a", "version": "1.0.0", "type": "object", "title": "T"}
    new = {"title": "T", "type": "object", "version": "2.0.0", "$id": "b"}
    assert diff(old, new) == ""


def test_the_digest_is_the_sha256_of_the_diff_text():
    text = diff({"type": "string"}, {"type": "integer"})
    assert diff_sha256(text) == hashlib.sha256(text.encode("utf-8")).hexdigest()
