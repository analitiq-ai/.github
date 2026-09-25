"""MAJOR.MINOR.PATCH versions and the bumps that advance them."""
from __future__ import annotations

import re

BUMPS = ("major", "minor", "patch")

# SemVer core: ASCII digits, no leading zeros, so every parsed version formats back to itself.
_SEMVER_CORE = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")


def parse_semver(version: str) -> tuple[int, int, int]:
    match = _SEMVER_CORE.fullmatch(version)
    if not match:
        raise ValueError(f"invalid semver: {version!r} (expected MAJOR.MINOR.PATCH)")
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def is_semver(text: str) -> bool:
    return _SEMVER_CORE.fullmatch(text) is not None


def bump_version(base: str, bump: str) -> str:
    """Advance `base` by a bump in `BUMPS`, zeroing the lower components."""
    major, minor, patch = parse_semver(base)
    if bump == "patch":
        return f"{major}.{minor}.{patch + 1}"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    if bump == "major":
        return f"{major + 1}.0.0"
    raise ValueError(f"unknown bump {bump!r}")


def bump_between(old: str, new: str) -> str:
    """The bump that advanced `old` to `new`, read from the highest component that changed."""
    o, n = parse_semver(old), parse_semver(new)
    if n <= o:
        raise ValueError(f"{new} does not advance {old}")
    return "major" if n[0] != o[0] else "minor" if n[1] != o[1] else "patch"
