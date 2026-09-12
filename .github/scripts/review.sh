#!/usr/bin/env bash
set -euo pipefail
: "${OR_KEY:?OPEN_ROUTER_KEY secret is required}"
MODE="$1"

SYS_COMMON='Every comment'"'"'s "line" must be the new-file line number exactly as
you can count it in the unified diff below (the right-hand/"+" side) — never a
line number from any other view of the file. Only comment on a line that is
literally present in the diff text.'

SYS_FULL="You are a senior code reviewer. Report only real bugs, security issues,
and correctness problems. No style nits, no praise. There are no prior findings to
adjudicate — output an empty \"prior_findings\" array. $SYS_COMMON"

SYS_INC="You are a senior code reviewer. You previously raised the findings in
PRIOR_FINDINGS. You are now seeing ONLY the changes made since then. For each entry
in PRIOR_FINDINGS, output one \"prior_findings\" entry with status \"resolved\",
\"not_addressed\", or \"partially_addressed\" and a one-line note. Then report any
NEW bugs introduced by these changes as \"comments\". Never re-report a fixed issue
as a new comment. No style nits. $SYS_COMMON"

[ "$MODE" = incremental ] && SYS="$SYS_INC" || SYS="$SYS_FULL"

SCHEMA='{"type":"json_schema","json_schema":{"name":"review","strict":true,"schema":{
 "type":"object","required":["summary","comments","prior_findings"],"additionalProperties":false,
 "properties":{
  "summary":{"type":"string"},
  "prior_findings":{"type":"array","items":{
    "type":"object","required":["finding","status","note"],
    "additionalProperties":false,
    "properties":{"finding":{"type":"string"},
      "status":{"type":"string","enum":["resolved","not_addressed","partially_addressed"]},
      "note":{"type":"string"}}}},
  "comments":{"type":"array","items":{
    "type":"object","required":["path","line","severity","body"],
    "additionalProperties":false,
    "properties":{"path":{"type":"string"},"line":{"type":"integer"},
      "severity":{"type":"string","enum":["critical","major","minor"]},
      "body":{"type":"string"}}}}}}}}'

# SYS_FULL tells the model no prior findings exist; keep that true by never
# handing it prior.json, even though the fetch step always runs (a
# "/review full" re-review of a PR with prior bot comments would otherwise
# get a PRIOR_FINDINGS block that contradicts the system prompt).
if [ "$MODE" = incremental ]; then
  PRIOR_JSON="$(cat /tmp/prior.json 2>/dev/null || echo '[]')"
else
  PRIOR_JSON='[]'
fi

jq -n --arg m "$MODEL" --arg s "$SYS" \
      --arg d "$(cat /tmp/diff.txt)" \
      --arg p "$PRIOR_JSON" \
      --argjson f "$SCHEMA" '{
  model:$m, response_format:$f,
  messages:[{role:"system",content:$s},
            {role:"user",content:("PRIOR_FINDINGS:\n"+$p+"\n\nDIFF:\n"+$d)}]
}' > /tmp/req.json

: "${COMMENT_ID:?COMMENT_ID (the id of the triggering comment) is required}"

# A failure here is otherwise only visible as a red Actions run — post it as
# a normal PR comment too, so the commenter isn't left guessing whether
# /review did anything.
post_failure_comment() {
  local reason="$1" excerpt
  excerpt="$(head -c 2000 /tmp/response.json 2>/dev/null)"
  jq -n --arg reason "$reason" --arg body "${excerpt:-<no response body>}" \
    '{body: ("**AI review did not run** — " + $reason + ".\n\n```\n" + $body + "\n```")}' \
    | gh api "repos/$REPO/issues/$PR/comments" -X POST --input - > /dev/null 2>&1 || true
}

set +e
curl -sS --fail-with-body https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OR_KEY" -H "Content-Type: application/json" \
  -d @/tmp/req.json -o /tmp/response.json
CURL_STATUS=$?
set -e

if [ "$CURL_STATUS" -ne 0 ]; then
  echo "::error::OpenRouter request failed (curl exit $CURL_STATUS):"
  cat /tmp/response.json >&2 || true
  post_failure_comment "the OpenRouter request failed (curl exit $CURL_STATUS)"
  exit "$CURL_STATUS"
fi

# OpenRouter didn't reject the request outright (no HTTP-level error) — ack
# the trigger comment now, before spending time validating/posting the
# actual review, so the commenter knows /review was picked up. Best-effort:
# a reaction failing here shouldn't fail an otherwise-working review.
gh api "repos/$REPO/issues/comments/$COMMENT_ID/reactions" -f content=eyes > /dev/null 2>&1 || true

if ! jq -e '.choices[0].message.content' /tmp/response.json > /dev/null 2>&1; then
  echo "::error::OpenRouter response missing choices[0].message.content:"
  cat /tmp/response.json >&2
  post_failure_comment "OpenRouter's response didn't include a usable result"
  exit 1
fi

jq -r '.choices[0].message.content' /tmp/response.json > /tmp/out.json
