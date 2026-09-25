"""Synthetic schema pairs with a known bump, one per structural class.

The historical corpus is small, and the confidence floor was chosen on the same
data it is scored on; these pairs are what validate the floor. Every schema
is built from `_base()`, a closed object, so adding an optional property only
widens and removing one only narrows; each pair differs by the change its name
states.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Callable

UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"


@dataclass(frozen=True)
class Pair:
    name: str
    old: dict
    new: dict
    label: str


def _base() -> dict[str, Any]:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "title": "Probe",
        "description": "A probe document.",
        "additionalProperties": False,
        "required": ["id", "kind"],
        "properties": {
            "id": {"type": "string", "pattern": UUID_PATTERN},
            "kind": {"type": "string", "enum": ["a", "b"]},
            "name": {"type": "string", "minLength": 1, "maxLength": 64},
            "count": {"type": "integer", "minimum": 0, "maximum": 100},
            "mode": {"const": "fast"},
            "source": {"anyOf": [{"$ref": "#/$defs/Table"}, {"$ref": "#/$defs/Query"}]},
            "tags": {"type": "array", "items": {"type": "string"}},
        },
        "$defs": {
            "Table": {
                "type": "object", "additionalProperties": False, "required": ["table"],
                "properties": {"table": {"type": "string"}},
            },
            "Query": {
                "type": "object", "additionalProperties": False, "required": ["sql"],
                "properties": {"sql": {"type": "string"}},
            },
        },
    }


def _edited(edit: Callable[[dict], None]) -> dict:
    schema = _base()
    edit(schema)
    return schema


def _props(schema: dict) -> dict:
    return schema["properties"]


def _both_ways(name: str, edit: Callable[[dict], None], forward: str, backward: str) -> list[Pair]:
    """The edit applied to `_base()`, and undone."""
    old, new = _base(), _edited(edit)
    return [Pair(name, old, new, forward), Pair(f"{name} (reversed)", copy.deepcopy(new), copy.deepcopy(old), backward)]


def _rename_def(schema: dict) -> None:
    schema["$defs"]["Sql"] = schema["$defs"].pop("Query")
    schema["properties"]["source"]["anyOf"][1] = {"$ref": "#/$defs/Sql"}


def _with_dialect_queries(schema: dict) -> None:
    """Closed query definitions that differ only in whether `dialect` is required."""
    for name, required in (("StrictQuery", ["sql", "dialect"]), ("LooseQuery", ["sql"])):
        schema["$defs"][name] = {
            "type": "object", "additionalProperties": False, "required": required,
            "properties": {"sql": {"type": "string"}, "dialect": {"type": "string"}},
        }


def _source_to(definition: str) -> Callable[[dict], None]:
    def edit(schema: dict) -> None:
        _with_dialect_queries(schema)
        schema["properties"]["source"]["anyOf"][1] = {"$ref": f"#/$defs/{definition}"}
    return edit


def _open(schema: dict) -> None:
    schema["additionalProperties"] = True


def _declare_on_open(schema: dict) -> None:
    _open(schema)
    _props(schema)["extra"] = {"type": "string"}


PAIRS: list[Pair] = [
    # Each CRITERIA example, in both directions.
    *_both_ways("optional property added", lambda s: _props(s).update(note={"type": "string"}), "minor", "major"),
    *_both_ways("enum value added", lambda s: _props(s)["kind"]["enum"].append("c"), "minor", "major"),
    *_both_ways(
        "anyOf branch added",
        lambda s: _props(s)["source"]["anyOf"].append({"type": "string"}), "minor", "major",
    ),
    *_both_ways("name removed from required", lambda s: s["required"].remove("kind"), "minor", "major"),
    *_both_ways("type widened", lambda s: _props(s)["name"].update(type=["string", "null"]), "minor", "major"),
    *_both_ways("pattern removed", lambda s: _props(s)["id"].pop("pattern"), "minor", "major"),
    *_both_ways("minLength loosened", lambda s: _props(s)["name"].update(minLength=0), "minor", "major"),
    *_both_ways("maximum loosened", lambda s: _props(s)["count"].update(maximum=1000), "minor", "major"),
    *_both_ways("const removed", lambda s: _props(s)["mode"].pop("const"), "minor", "major"),
    *_both_ways("additionalProperties false removed", lambda s: s.pop("additionalProperties"), "minor", "major"),
    *_both_ways(
        "UUID pattern replaced by minLength 1",
        lambda s: _props(s)["id"].update({"minLength": 1}) or _props(s)["id"].pop("pattern"), "minor", "major",
    ),
    *_both_ways(
        "const replaced by a pattern that includes it",
        lambda s: _props(s).update(mode={"type": "string", "pattern": "^fast"}), "minor", "major",
    ),
    Pair(
        "property renamed", _base(),
        _edited(lambda s: _props(s).update(title=_props(s).pop("name"))), "major",
    ),
    Pair(
        "discriminated oneOf branch added",
        _edited(lambda s: _props(s).update(source={"oneOf": [{"$ref": "#/$defs/Table"}]})),
        _edited(lambda s: _props(s).update(source={"oneOf": [{"$ref": "#/$defs/Table"}, {"$ref": "#/$defs/Query"}]})),
        "minor",
    ),
    # Tightenings that read as additions: each adds a key or a list item.
    Pair("allOf conjunct appended", _base(), _edited(lambda s: s.update(allOf=[{"minProperties": 3}])), "major"),
    Pair(
        "allOf with if/then introduced", _base(),
        _edited(lambda s: s.update(allOf=[{
            "if": {"properties": {"kind": {"const": "b"}}},
            "then": {"required": ["name"]},
        }])),
        "major",
    ),
    Pair(
        "prefixItems member appended",
        _edited(lambda s: _props(s)["tags"].update(prefixItems=[{"const": "first"}])),
        _edited(lambda s: _props(s)["tags"].update(prefixItems=[{"const": "first"}, {"const": "second"}])),
        "major",
    ),
    Pair(
        "overlapping oneOf branch added",
        _edited(lambda s: _props(s).update(name={"oneOf": [{"type": "string"}]})),
        _edited(lambda s: _props(s).update(name={"oneOf": [{"type": "string"}, {"minLength": 1}]})),
        "major",
    ),
    Pair(
        "top-level required introduced",
        _edited(lambda s: s.pop("required")), _base(), "major",
    ),
    Pair(
        "schema declared for a key an open object accepted",
        _edited(_open), _edited(_declare_on_open), "major",
    ),
    # Only the $ref changes, so what it now points at is in no diff hunk.
    Pair(
        "anyOf branch retargeted to a stricter definition",
        _edited(_source_to("LooseQuery")), _edited(_source_to("StrictQuery")), "major",
    ),
    Pair(
        "anyOf branch retargeted to a looser definition",
        _edited(_source_to("StrictQuery")), _edited(_source_to("LooseQuery")), "minor",
    ),
    # Deep in a list longer than the diff's context, a hunk shows only sibling
    # members, never the keyword that owns the list.
    Pair(
        "last property added to a long required list",
        _edited(lambda s: s.update(required=["id", "kind", "name", "count", "mode", "source"])),
        _edited(lambda s: s.update(required=["id", "kind", "name", "count", "mode", "source", "tags"])),
        "major",
    ),
    Pair(
        "value appended to a long enum",
        _edited(lambda s: _props(s)["kind"].update(enum=list("abcdefgh"))),
        _edited(lambda s: _props(s)["kind"].update(enum=list("abcdefghi"))),
        "minor",
    ),
    # Policy: a $defs name is addressable, so renaming one breaks.
    Pair("$defs entry renamed with its $refs", _base(), _edited(_rename_def), "major"),
    # Annotations do not change what validates.
    Pair(
        "x-secret annotation added", _base(),
        _edited(lambda s: _props(s)["name"].update({"x-secret": True})), "minor",
    ),
    Pair("deprecated annotation added", _base(), _edited(lambda s: _props(s)["count"].update(deprecated=True)), "minor"),
    # Documentation only.
    Pair("description reworded", _base(), _edited(lambda s: s.update(description="A probe.")), "patch"),
    Pair("property title added", _base(), _edited(lambda s: _props(s)["name"].update(title="Name")), "patch"),
    Pair("examples added", _base(), _edited(lambda s: _props(s)["count"].update(examples=[3])), "patch"),
]
