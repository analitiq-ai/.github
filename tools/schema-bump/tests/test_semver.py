"""Versions are SemVer core exactly, and a bump is read only from a pair that advances."""
from __future__ import annotations

import pytest

from schema_bump.semver import bump_between, bump_version, parse_semver


@pytest.mark.parametrize(
    "version",
    [
        pytest.param("1.2.3\n", id="trailing-newline"),
        pytest.param("01.2.3", id="leading-zero"),
        pytest.param("1.02.3", id="leading-zero-minor"),
        pytest.param("١.2.3", id="non-ascii-digit"),
        pytest.param("1.2", id="two-components"),
        pytest.param("1.2.3-rc.1", id="prerelease"),
    ],
)
def test_a_version_outside_semver_core_is_refused(version):
    with pytest.raises(ValueError):
        parse_semver(version)


@pytest.mark.parametrize("version", ["0.0.0", "1.2.3", "10.20.30"])
def test_a_parsed_version_formats_back_to_itself(version):
    assert ".".join(map(str, parse_semver(version))) == version


@pytest.mark.parametrize(("old", "new", "bump"), [("1.2.3", "2.0.0", "major"), ("1.2.3", "1.3.0", "minor"), ("1.2.3", "1.2.4", "patch")])
def test_the_bump_between_versions_is_the_component_that_advanced(old, new, bump):
    assert bump_between(old, new) == bump
    assert bump_version(old, bump) == new


@pytest.mark.parametrize(("old", "new"), [("1.2.3", "1.2.3"), ("1.3.0", "1.2.9"), ("2.0.0", "1.9.9")])
def test_a_pair_that_does_not_advance_has_no_bump(old, new):
    with pytest.raises(ValueError):
        bump_between(old, new)
