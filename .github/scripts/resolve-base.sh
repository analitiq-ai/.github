#!/usr/bin/env bash
set -euo pipefail

# gh's GraphQL-backed `pr view` reports a bot's login without the "[bot]"
# suffix that the REST API uses (see the "Prior findings" step in
# ai-review.yml, which reads the REST endpoint and matches
# "github-actions[bot]"). Strip a possible "[bot]" suffix defensively so a
# future gh/API change can't silently disable incremental mode forever.
BASE=$(gh pr view "$PR" --json reviews \
  --jq '[.reviews[] | select((.author.login | rtrimstr("[bot]"))=="github-actions")
         | .body | capture("<!-- ai-review-sha:(?<s>[0-9a-f]+) -->").s][-1] // ""')

case "$COMMENT_BODY" in /review\ full*) BASE="" ;; esac

# guard: stored SHA must exist locally, else we silently full-review forever
if [ -n "$BASE" ] && ! git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  echo "::warning::stored SHA $BASE missing — check fetch-depth"
  BASE=""
fi

if [ -z "$BASE" ]; then
  BASE=$(git merge-base "origin/${DEFAULT_BRANCH}" "$HEAD_SHA")
  echo "mode=full" >> "$GITHUB_OUTPUT"
  echo "::notice::no usable prior review SHA — running a full review"
else
  echo "mode=incremental" >> "$GITHUB_OUTPUT"
  echo "::notice::incremental review since $BASE"
fi
echo "sha=$BASE" >> "$GITHUB_OUTPUT"
