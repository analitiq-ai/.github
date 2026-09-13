#!/usr/bin/env bash
set -euo pipefail
: "${OR_KEY:?OPEN_ROUTER_KEY secret is required}"
: "${COMMENT_ID:?COMMENT_ID (the id of the triggering comment) is required}"
MODE="$1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools.sh
source "$SCRIPT_DIR/tools.sh"

MAX_TOOL_ROUNDS=6

SYS_COMMON='Every comment'"'"'s "line" must be the new-file line number exactly as
you can count it in the unified diff below (the right-hand/"+" side) — never a
line number from any other view of the file. Only comment on a line that is
literally present in the diff text.

You have read-only tools — read_file, grep, list_files — against the PR'"'"'s
own head commit. The diff alone cannot carry repo-wide convention: whether a
referenced field exists, whether a naming rule holds elsewhere, what a
function you did not see the definition of actually does. Call a tool before
asserting a claim like that, rather than guessing from the diff text alone.
Do not call a tool for anything already fully visible in the diff.'

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
if [ "$MODE" = incremental ] && [ -s /tmp/prior.json ]; then
  PRIOR_FILE=/tmp/prior.json
else
  echo '[]' > /tmp/prior_empty.json
  PRIOR_FILE=/tmp/prior_empty.json
fi

# --rawfile/--slurpfile read straight from the filesystem rather than via an
# argv-embedded `$(cat ...)` — a full-budget diff (build-diff.sh allows up to
# ~100KB) plus accumulated tool output already exceeds Linux's ~128KB
# per-argument limit later in the loop, and a jq call that dies from
# "Argument list too long" leaves req.json truncated (often to empty) rather
# than failing loudly, so curl posts garbage and the resulting error blames
# OpenRouter for a local overflow. Every place a potentially large file's
# content reaches jq in this script goes through one of these two, never
# through --arg on a command substitution.
jq -n --arg s "$SYS" --rawfile d /tmp/diff.txt --slurpfile p "$PRIOR_FILE" '
  [{role:"system",content:$s},
   {role:"user",content:("PRIOR_FINDINGS:\n"+($p[0]|tostring)+"\n\nDIFF:\n"+$d)}]' \
  > /tmp/messages.json

# A failure here is otherwise only visible as a red Actions run — post it as
# a normal PR comment too, so the commenter isn't left guessing whether
# /review did anything.
post_failure_comment() {
  local reason="$1" excerpt
  # `|| true` matters: curl never creates the -o file when it fails before
  # receiving a body at all (DNS/connection/TLS failure), so head errors —
  # and under set -e that would kill this function before jq/gh ever run,
  # silently skipping the one comment this whole function exists to post.
  excerpt="$(head -c 2000 /tmp/response.json 2>/dev/null || true)"
  jq -n --arg reason "$reason" --arg body "${excerpt:-<no response body>}" \
    '{body: ("**AI review did not run** — " + $reason + ".\n\n```\n" + $body + "\n```")}' \
    | gh api "repos/$REPO/issues/$PR/comments" -X POST --input - > /dev/null \
    || echo "::warning::couldn't post the failure comment (check issues: write on the caller)"
}

REACTED=""
ack_once() {
  [ -n "$REACTED" ] && return 0
  # OpenRouter didn't reject the request outright (no HTTP-level error) — ack
  # the trigger comment now, before spending time investigating/posting the
  # actual review, so the commenter knows /review was picked up. Best-effort:
  # a reaction failing here shouldn't fail an otherwise-working review, but it
  # still needs to say why instead of just silently not appearing.
  gh api "repos/$REPO/issues/comments/$COMMENT_ID/reactions" -f content=eyes > /dev/null \
    || echo "::warning::couldn't add the 👀 reaction (check issues: write on the caller)"
  REACTED=1
}

# Sends the current /tmp/messages.json as one chat-completions call, retrying
# transient failures up to twice more (network blip, a 429/5xx) — going from
# one call to as many as seven per review multiplies exposure to a transient
# failure by the same factor, so absorbing it here matters more than it did
# before. $1: extra top-level JSON object merged into the request (tools, or
# response_format for the final structuring call). Writes /tmp/response.json
# and returns curl's exit status; does not itself post a failure comment or
# exit, since a mid-loop failure and the final call's failure carry different
# messages.
call_openrouter() {
  local extra="$1" status attempt
  jq --arg m "$MODEL" --argjson extra "$extra" '{model:$m, messages:.} + $extra' \
    /tmp/messages.json > /tmp/req.json
  for attempt in 1 2 3; do
    set +e
    curl -sS --fail-with-body https://openrouter.ai/api/v1/chat/completions \
      -H "Authorization: Bearer $OR_KEY" -H "Content-Type: application/json" \
      -H "HTTP-Referer: https://github.com/analitiq-ai" -H "X-Title: analitiq-ai /review" \
      -d @/tmp/req.json -o /tmp/response.json
    status=$?
    set -e
    [ "$status" -eq 0 ] && return 0
    [ "$attempt" -lt 3 ] && sleep 3
  done
  return "$status"
}

append_message() {
  # $1: a JSON message object, as text. Written to a file and read with
  # --slurpfile rather than passed as --argjson — nothing caps how long an
  # assistant turn's own content can run before it decides to call a tool
  # (the benchmark that motivated this workflow saw one model emit ~1.85MB
  # in a single turn), so the same argv-overflow risk applies here as
  # everywhere else large content reaches jq in this script.
  printf '%s' "$1" > /tmp/new_message.json
  jq --slurpfile m /tmp/new_message.json '. + [$m[0]]' /tmp/messages.json > /tmp/messages.json.tmp
  mv /tmp/messages.json.tmp /tmp/messages.json
}

# Phase 1: let the model investigate with tools. No response_format here —
# strict structured-output and multi-round tool calling aren't reliably
# combinable across every OpenRouter-routed provider, so tool use runs
# unconstrained and a separate final call (phase 2) forces the schema once
# the model is done looking things up.
round=0
stopped_naturally=""
while [ "$round" -lt "$MAX_TOOL_ROUNDS" ]; do
  round=$((round + 1))

  if call_openrouter "$(jq -n --argjson t "$TOOLS_SCHEMA" '{tools:$t}')"; then
    ack_once
  else
    curl_status=$?
    echo "::error::OpenRouter request failed during investigation, round $round (curl exit $curl_status):"
    cat /tmp/response.json >&2 || true
    post_failure_comment "the OpenRouter request failed while investigating (round $round)"
    exit 1
  fi

  # Append the assistant's turn unconditionally — including the plain-text
  # turn that ends the loop below, so phase 2 shapes the analysis the model
  # already reached instead of re-deriving the whole review from scratch.
  append_message "$(jq -c '.choices[0].message' /tmp/response.json)"

  TOOL_CALLS=$(jq -c '.choices[0].message.tool_calls // []' /tmp/response.json 2>/dev/null) || TOOL_CALLS="[]"
  if [ "$TOOL_CALLS" = "[]" ] || [ "$TOOL_CALLS" = "null" ]; then
    stopped_naturally=1
    break
  fi

  while IFS= read -r call; do
    [ -z "$call" ] && continue
    call_id=$(jq -r '.id // "unknown"' <<<"$call")
    fn=$(jq -c '.function' <<<"$call")
    result=$(dispatch_tool_call "$fn")
    append_message "$(jq -n --arg id "$call_id" --arg content "$result" '{role:"tool", tool_call_id:$id, content:$content}')"
  done < <(jq -c '.[]' <<<"$TOOL_CALLS")
done

# `round == MAX_TOOL_ROUNDS` on its own can't tell a model that stopped on
# its last permitted round from one that was cut off — stopped_naturally is
# only set on the break above, so it's the one thing that actually
# distinguishes the two.
if [ -n "$stopped_naturally" ]; then
  append_message '{"role":"user","content":"You now have everything you asked for. Produce your final review now."}'
else
  append_message '{"role":"user","content":"You have reached the tool-call limit. Stop investigating and produce your final review now, from what you have already learned."}'
fi

# Phase 2: one final call, schema-constrained, no tools — whatever the model
# learned above is already in the conversation, so this call only has to
# shape it into the structured verdict.
if call_openrouter "$(jq -n --argjson f "$SCHEMA" '{response_format:$f}')"; then
  ack_once
else
  curl_status=$?
  echo "::error::OpenRouter request failed on the final structuring call (curl exit $curl_status):"
  cat /tmp/response.json >&2 || true
  post_failure_comment "the OpenRouter request failed while finalizing the review"
  exit 1
fi

if ! jq -e '.choices[0].message.content | strings | select(length > 0)' /tmp/response.json > /dev/null 2>&1; then
  echo "::error::OpenRouter response missing a non-empty choices[0].message.content:"
  cat /tmp/response.json >&2
  post_failure_comment "OpenRouter's response didn't include a usable result"
  exit 1
fi

jq -r '.choices[0].message.content' /tmp/response.json > /tmp/out.json
