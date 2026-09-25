"""MAJOR.MINOR.PATCH versions and the bumps that advance them."""
from __future__ import annotations

import re

BUMPS = ("major", "minor", "patch")

SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


def parse_semver(version: str) -> tuple[int, int, int]:
    match = SEMVER_RE.match(version)
    if not match:
        raise ValueError(f"invalid semver: {version!r} (expected MAJOR.MINOR.PATCH)")
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


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
    """The bump that advanced `old` to `new`, read from the component that changed."""
    o, n = parse_semver(old), parse_semver(new)
    return "major" if n[0] != o[0] else "minor" if n[1] != o[1] else "patch"
