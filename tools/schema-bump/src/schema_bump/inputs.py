"""The tool's one reader of an external JSON file."""
from __future__ import annotations

import json
from pathlib import Path


def read_json_object(path: Path) -> dict:
    """The JSON object at `path`; ValueError naming the path and the reason otherwise.

    ValueError covers both a malformed document and text that is not UTF-8.
    """
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(f"{path}: cannot be read as JSON: {error}") from error
    if not isinstance(document, dict):
        raise ValueError(f"{path}: not a JSON object")
    return document
