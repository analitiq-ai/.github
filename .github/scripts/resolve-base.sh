#!/usr/bin/env bash
set -euo pipefail

# gh's GraphQL-backed `pr view` reports a bot's login without the "[bot]"
# suffix that the REST API uses (see .github/scripts/review comment fetch,
# which reads the REST endpoint and matches "github-actions[bot]" instead).
BASE=$(gh pr view "$PR" --json reviews \
  --jq '[.reviews[] | select(.author.login=="github-actions")
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
else
  echo "mode=incremental" >> "$GITHUB_OUTPUT"
fi
echo "sha=$BASE" >> "$GITHUB_OUTPUT"
