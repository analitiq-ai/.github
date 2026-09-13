#!/usr/bin/env bash
set -euo pipefail
HEAD_SHA="$1"
MODE="${2:-full}"

# lines actually present in the diff, as "path:line" (new-file/right-hand side).
# `next` after the +++ rule matters: without it, a file-header line itself
# falls through to the "+"-content rule below using the previous file's
# leftover line counter, injecting a bogus entry into the allowlist.
awk '/^--- /{p=""}
     /^\+\+\+ b\//{p=substr($0,7); next}
     /^@@/{split($0,a," "); split(a[3],b,","); n=substr(b[1],2)+0; next}
     /^\+/&&p{print p":"n; n++}
     /^ /&&p{n++}' /tmp/diff.txt | sort -u > /tmp/valid.txt

jq -c '.comments[]' /tmp/out.json | while read -r c; do
  key="$(jq -r '.path' <<<"$c"):$(jq -r '.line' <<<"$c")"
  if grep -qxF "$key" /tmp/valid.txt; then
    echo "$c"
  fi
done | jq -s '[.[] | {path, line, side:"RIGHT", body:("**\(.severity)** — \(.body)")}]' \
  > /tmp/comments.json

TOTAL=$(jq '.comments | length' /tmp/out.json)
KEPT=$(jq 'length' /tmp/comments.json)
echo "::notice::posting $KEPT/$TOTAL model-proposed inline comments (rest failed the diff-line-anchor check)"

# A genuinely clean review (nothing proposed, nothing to adjudicate from a
# prior round) gets a fixed message rather than the model's own freeform
# summary — "reviewed this diff, no bugs" reads differently every time
# depending on wording the model chose, for a case with only one real
# outcome to report. But "clean" isn't the same claim as "complete": say so
# when build-diff.sh dropped files for size, or this was only an
# incremental pass — otherwise the fixed wording overclaims coverage the
# model's own summary would have caveated.
if [ "$TOTAL" -eq 0 ] && [ "$(jq '(.prior_findings // []) | length' /tmp/out.json)" -eq 0 ]; then
  SUMMARY="Reviewed — no issues found."
  if [ "$MODE" = "incremental" ]; then
    SUMMARY="$SUMMARY (incremental — only the changes since the last review)"
  fi
  if grep -q '^SKIPPED_FILES:' /tmp/diff.txt; then
    SKIPPED=$(grep '^SKIPPED_FILES:' /tmp/diff.txt | sed 's/^SKIPPED_FILES://')
    SUMMARY="$SUMMARY Some files were too large to include in this review:$SKIPPED."
  fi
else
  SUMMARY=$(jq -r '.summary' /tmp/out.json)
fi
PRIOR=$(jq -r '
  (.prior_findings // []) as $pf
  | if ($pf|length) > 0 then
      "\n\n**Prior findings:**\n" + ( [ $pf[] | "- **\(.status)** — \(.finding): \(.note)" ] | join("\n") )
    else "" end
' /tmp/out.json)

BODY="$SUMMARY$PRIOR

<!-- ai-review-sha:$HEAD_SHA -->"

jq -n --arg body "$BODY" --arg commit "$HEAD_SHA" --slurpfile c /tmp/comments.json \
  '{event:"COMMENT", body:$body, commit_id:$commit, comments:$c[0]}' \
  | gh api "repos/$REPO/pulls/$PR/reviews" -X POST --input -
