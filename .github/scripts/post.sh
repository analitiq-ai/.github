#!/usr/bin/env bash
set -euo pipefail
HEAD_SHA="$1"

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

SUMMARY=$(jq -r '.summary' /tmp/out.json)
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
