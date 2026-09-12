#!/usr/bin/env bash
set -euo pipefail
HEAD_SHA="$1"

# lines actually present in the diff, as "path:line"
awk '/^\+\+\+ b\//{p=substr($0,7)}
     /^@@/{split($0,a," "); split(a[3],b,","); n=substr(b[1],2)+0; next}
     /^\+/&&p{print p":"n; n++}
     /^ /&&p{n++}' /tmp/diff.txt | sort -u > /tmp/valid.txt

jq -c '.comments[]' /tmp/out.json | while read -r c; do
  key="$(jq -r '.path' <<<"$c"):$(jq -r '.line' <<<"$c")"
  grep -qx "$key" /tmp/valid.txt && echo "$c"
done | jq -s '[.[] | {path, line, side:"RIGHT", body:("**\(.severity)** — \(.body)")}]' \
  > /tmp/comments.json

SUMMARY=$(jq -r '.summary' /tmp/out.json)
RESOLVED=$(jq -r '.resolved // [] | if length>0 then "\n\n**Resolved since last review:**\n- "+join("\n- ") else "" end' /tmp/out.json)

gh api "repos/$REPO/pulls/$PR/reviews" -X POST \
  -f event=COMMENT \
  -f body="$SUMMARY$RESOLVED

<!-- ai-review-sha:$HEAD_SHA -->" \
  -F comments@/tmp/comments.json
