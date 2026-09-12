#!/usr/bin/env bash
set -euo pipefail
MODE="$1"

SYS_FULL='You are a senior code reviewer. Report only real bugs, security issues,
and correctness problems. No style nits, no praise. Every finding must cite a line
present in the diff.'

SYS_INC='You are a senior code reviewer. You previously raised the findings in
PRIOR_FINDINGS. You are now seeing ONLY the changes made since then. For each prior
finding output RESOLVED, NOT_ADDRESSED, or PARTIALLY_ADDRESSED with one line of
justification. Then report any NEW bugs introduced by these changes. Never re-report
a fixed issue. No style nits.'

[ "$MODE" = incremental ] && SYS="$SYS_INC" || SYS="$SYS_FULL"

SCHEMA='{"type":"json_schema","json_schema":{"name":"review","strict":true,"schema":{
 "type":"object","required":["summary","comments"],"additionalProperties":false,
 "properties":{
  "summary":{"type":"string"},
  "resolved":{"type":"array","items":{"type":"string"}},
  "comments":{"type":"array","items":{
    "type":"object","required":["path","line","severity","body"],
    "additionalProperties":false,
    "properties":{"path":{"type":"string"},"line":{"type":"integer"},
      "severity":{"type":"string","enum":["critical","major","minor"]},
      "body":{"type":"string"}}}}}}}}'

jq -n --arg m "$MODEL" --arg s "$SYS" \
      --arg d "$(cat /tmp/diff.txt)" \
      --arg p "$(cat /tmp/prior.json 2>/dev/null || echo '[]')" \
      --argjson f "$SCHEMA" '{
  model:$m, response_format:$f,
  messages:[{role:"system",content:$s},
            {role:"user",content:("PRIOR_FINDINGS:\n"+$p+"\n\nDIFF:\n"+$d)}]
}' > /tmp/req.json

curl -sS --fail-with-body https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OR_KEY" -H "Content-Type: application/json" \
  -d @/tmp/req.json | jq -r '.choices[0].message.content' > /tmp/out.json
