"""The model cascade that decides the semver bump a schema change requires.

Stage 1 (Jev) classifies the diff; a confidence below `CONFIDENCE_FLOOR`, or a
diff too large for Jev, escalates to stage 2 (Luna), which also reads both
whole schemas.
Any other failure stops classification with an exception: there is no fallback
severity.

The model pins, the floor and every prompt text are stated here once; the
evaluation (`schema-bump eval`) grades them, and changing any of
them means re-running it.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

from .diff import unstamped
from .semver import BUMPS

JEV_MODEL = "typesafe/jev-1.13"
LUNA_MODEL = "openai/gpt-6-luna"
CONFIDENCE_FLOOR = 0.7
LUNA_MAX_TOKENS = 16000

# Jev is served from OpenRouter's alpha path, which may move; it is stated here only.
JEV_URL = "https://openrouter.ai/api/alpha/decisions"
CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"


CRITERIA = {
    "major": (
        "Breaking. Some document the OLD schema accepted is rejected by the NEW schema, or an "
        "existing field changes meaning. Examples: a property, $defs entry, enum value or "
        "anyOf/oneOf branch removed or renamed; a name added to `required`; a type narrowed; a "
        "constraint (pattern, minLength, maximum, const, additionalProperties false) added or "
        "tightened."
    ),
    "minor": (
        "Backward-compatible structural change. Every document the OLD schema accepted is still "
        "accepted, and the NEW schema accepts more: a new optional property, a new enum value, a "
        "new anyOf/oneOf branch, a name removed from `required`, a constraint loosened."
    ),
    "patch": (
        "Documentation only. Only description, title, examples or $comment text changed; the set "
        "of accepted documents is identical."
    ),
}

JEV_INSTRUCTIONS = (
    "`diff` is a unified diff between the OLD and NEW JSON Schema of `resource`, each printed "
    "with sorted keys and without `$id`/`version`. Which semantic-version bump does the NEW "
    "schema require? Pick the most severe category that any single change falls into."
)

LUNA_SYSTEM = (
    "You classify the semantic-version bump a JSON Schema change requires.\n"
    "The payload has `diff` (a unified diff between the OLD and NEW schema of `resource`, each "
    "printed with sorted keys and without $id/version) and the full `old_schema` and "
    "`new_schema`. Use the schemas to judge context the diff omits: which definition a hunk "
    "sits in, whether an enclosing object forbids additional properties, whether a removed "
    "definition is still referenced, what a $ref now points at.\n"
    "Pick the most severe category that any single change falls into.\n"
    "\n"
    "Categories:\n"
    + "".join(f"- {bump}: {CRITERIA[bump]}\n" for bump in BUMPS)
).rstrip("\n")

LUNA_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "bump",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["reasoning", "bump"],
            "properties": {
                "reasoning": {
                    "type": "string",
                    "description": "At most three sentences: the most severe change and why.",
                },
                "bump": {"type": "string", "enum": list(BUMPS)},
            },
        },
    },
}

# The Jev error code for a request over its context window.
_JEV_OVERSIZED = "max_tokens_exceeded"
_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504, 529})
_RETRY_DELAYS = (2.0, 5.0, 15.0)

# (url, payload) -> (HTTP status, parsed JSON body)
Post = Callable[[str, dict], tuple[int, Any]]


class BumpClassificationError(Exception):
    """The cascade produced no classification."""


@dataclass(frozen=True)
class Decision:
    """A classified change, in the shape a bump record stores, plus its cost."""

    stage1: dict
    stage2: dict | None
    final: str
    cost: float


def openrouter_post(api_key: str, *, sleep: Callable[[float], None] = time.sleep) -> Post:
    """A `Post` that calls OpenRouter, retrying 429 and 5xx responses."""

    def post(url: str, payload: dict) -> tuple[int, Any]:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        attempt = 0
        while True:
            try:
                with urllib.request.urlopen(request, timeout=300) as response:
                    status, raw = response.status, response.read()
            except urllib.error.HTTPError as error:
                if error.code not in _RETRY_STATUSES or attempt == len(_RETRY_DELAYS):
                    return error.code, _error_body(error)
            except OSError as error:
                raise BumpClassificationError(f"cannot reach {url}: {error!r}") from error
            else:
                try:
                    return status, json.loads(raw)
                except json.JSONDecodeError as error:
                    raise BumpClassificationError(
                        f"{url} returned HTTP {status} with a body that is not JSON: {raw[:500]!r}"
                    ) from error
            sleep(_RETRY_DELAYS[attempt])
            attempt += 1

    return post


def _error_body(error: urllib.error.HTTPError) -> Any:
    raw = error.read()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"error": {"message": raw.decode("utf-8", "replace"), "code": error.code}}


def decide(resource: str, old: dict, new: dict, diff: str, post: Post) -> Decision:
    """Classify the change from `old` to `new`, whose diff is `diff`."""
    if not diff:
        raise ValueError("an empty diff needs no classification")
    stage1, cost = _ask_jev(resource, diff, post)
    if stage1_is_final(stage1):
        return Decision(stage1, None, routed_bump(stage1, None, None), cost)
    stage2, luna_cost = _ask_luna(stage2_payload(resource, old, new, diff), post)
    return Decision(stage1, stage2, routed_bump(stage1, stage2, None), cost + luna_cost)


def stage1_is_final(stage1: dict) -> bool:
    """Whether Jev decides alone: it answered, at or above the floor."""
    return "choice" in stage1 and stage1["confidence"] >= CONFIDENCE_FLOOR


def routed_bump(stage1: dict, stage2: dict | None, override: dict | None) -> str:
    """The bump that stands: the override, else the stage the routing made final."""
    if override is not None:
        return override["bump"]
    return stage1["choice"] if stage1_is_final(stage1) else stage2["bump"]


def override_problem(override: Any) -> str | None:
    """Why `override` is not a bump with a reason; None when it is."""
    if (
        not isinstance(override, dict)
        or override.keys() != {"bump", "reason"}
        or override["bump"] not in BUMPS
        or not isinstance(override["reason"], str)
        or not override["reason"].strip()
    ):
        return f"override {_brief(override)} is not a bump in {BUMPS} with a non-blank reason"
    return None


def decision_problem(stage1: Any, stage2: Any, override: Any, final: Any) -> str | None:
    """Why these stages, override and final are not what `decide` and an
    override produce together; None when they are."""
    if not _is_stage1(stage1):
        return f"stage1 {_brief(stage1)} is neither a Jev answer nor a skipped Jev call"
    if stage2 is not None and not _is_stage2(stage2):
        return f"stage2 {_brief(stage2)} is not a Luna answer"
    if (stage2 is None) != stage1_is_final(stage1):
        return f"stage 2 runs exactly when stage 1 has no answer at or above {CONFIDENCE_FLOOR}"
    if override is not None and (problem := override_problem(override)):
        return problem
    decided = routed_bump(stage1, stage2, override)
    if final != decided:
        return f"has final {final!r}, but its stages and override decide {decided!r}"
    return None


def _is_stage1(stage1: Any) -> bool:
    if stage1 == {"skipped": _JEV_OVERSIZED}:
        return True
    return (
        isinstance(stage1, dict)
        and stage1.keys() == {"model", "choice", "confidence", "probabilities"}
        and isinstance(stage1["model"], str)
        and stage1["choice"] in BUMPS
        and _is_probability(stage1["confidence"])
        and isinstance(stage1["probabilities"], dict)
    )


def _is_stage2(stage2: Any) -> bool:
    return (
        isinstance(stage2, dict)
        and stage2.keys() == {"model", "bump", "reasoning"}
        and isinstance(stage2["model"], str)
        and stage2["bump"] in BUMPS
        and isinstance(stage2["reasoning"], str)
    )


def _ask_jev(resource: str, diff: str, post: Post) -> tuple[dict, float]:
    status, body = post(JEV_URL, {
        "model": JEV_MODEL,
        "state": {"resource": resource, "diff": diff},
        "questions": {"bump": {
            "type": "choice",
            "instructions": JEV_INSTRUCTIONS,
            "criteria": CRITERIA,
        }},
    })
    if status == 400 and _error_code(body) == _JEV_OVERSIZED:
        return {"skipped": _JEV_OVERSIZED}, 0.0
    if status != 200:
        raise BumpClassificationError(f"Jev returned HTTP {status}: {_brief(body)}")
    try:
        answer = body["answers"]["bump"]
        stage1 = {
            "model": body["model"],
            "choice": answer["choice"],
            "confidence": answer["confidence"],
            "probabilities": answer["probabilities"],
        }
        cost = body["usage"]["cost"]
    except (KeyError, TypeError) as error:
        raise BumpClassificationError(f"Jev answer is missing {error}: {_brief(body)}") from error
    if not _is_stage1(stage1):
        raise BumpClassificationError(f"Jev answer is malformed: {_brief(body)}")
    return stage1, cost


def _error_code(body: Any) -> Any:
    error = body.get("error") if isinstance(body, dict) else None
    return error.get("code") if isinstance(error, dict) else None


def _is_probability(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1


def _ask_luna(payload: dict, post: Post) -> tuple[dict, float]:
    status, body = post(CHAT_URL, {
        "model": LUNA_MODEL,
        "max_tokens": LUNA_MAX_TOKENS,
        "usage": {"include": True},
        "response_format": LUNA_RESPONSE_FORMAT,
        "messages": [
            {"role": "system", "content": LUNA_SYSTEM},
            {"role": "user", "content": _compact(payload)},
        ],
    })
    if status != 200:
        raise BumpClassificationError(f"Luna returned HTTP {status}: {_brief(body)}")
    try:
        choice = body["choices"][0]
        finish_reason = choice["finish_reason"]
        content = choice["message"]["content"]
        model = body["model"]
        cost = body["usage"]["cost"]
    except (KeyError, IndexError, TypeError) as error:
        raise BumpClassificationError(f"Luna answer is missing {error}: {_brief(body)}") from error
    if finish_reason != "stop":
        raise BumpClassificationError(f"Luna stopped with finish_reason {finish_reason!r}")
    if not isinstance(content, str) or not content:
        raise BumpClassificationError("Luna returned no content")
    try:
        answer = json.loads(content)
    except json.JSONDecodeError as error:
        raise BumpClassificationError(f"Luna content is not JSON: {content!r}") from error
    if not isinstance(answer, dict):
        raise BumpClassificationError(f"Luna content is not a JSON object: {content!r}")
    stage2 = {"model": model, "bump": answer.get("bump"), "reasoning": answer.get("reasoning")}
    if not _is_stage2(stage2):
        raise BumpClassificationError(f"Luna answered no bump in {BUMPS} with reasoning: {content!r}")
    return stage2, cost


def stage2_payload(resource: str, old: dict, new: dict, diff: str) -> dict:
    """What Luna reads: the diff and both whole schemas, stamps excluded."""
    return {"resource": resource, "diff": diff, "old_schema": unstamped(old), "new_schema": unstamped(new)}


def _compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _brief(body: Any) -> str:
    return _compact(body)[:500]
