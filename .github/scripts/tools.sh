#!/usr/bin/env bash
# Read-only repo tools for the model, backed by git plumbing against the PR's
# head commit — never a working-tree checkout, so a tool call can surface
# file content without ever making PR-authored code executable.
#
# Sourced by review.sh (not run standalone — no `set -euo pipefail` here, so
# a single malformed or failing tool call can't abort the review loop via
# the caller's own -e). Requires PR_HEAD in the environment (the PR's head
# SHA, already fetched as objects-only by the "Fetch PR head" step).

TOOL_OUTPUT_CAP=8000   # bytes; keeps one tool result from dominating context
LIST_OUTPUT_CAP=4000

TOOLS_SCHEMA='[
  {"type":"function","function":{
    "name":"read_file",
    "description":"Read a file'"'"'s content as it exists at the PR'"'"'s head commit. Use this to verify a claim that depends on code or config not visible in the diff — e.g. whether a referenced field, function, or convention actually exists.",
    "parameters":{"type":"object","required":["path"],"additionalProperties":false,
      "properties":{"path":{"type":"string","description":"Repo-relative file path."}}}}},
  {"type":"function","function":{
    "name":"grep",
    "description":"Search file contents for an extended-regex pattern across the repo (or a glob within it) at the PR'"'"'s head commit. Use this to check whether an identifier or convention appears elsewhere in the codebase.",
    "parameters":{"type":"object","required":["pattern"],"additionalProperties":false,
      "properties":{"pattern":{"type":"string","description":"Extended-regex pattern."},
                    "glob":{"type":"string","description":"Optional pathspec to restrict the search, e.g. packages/**/*.py."}}}}},
  {"type":"function","function":{
    "name":"list_files",
    "description":"List repo files at the PR'"'"'s head commit, optionally filtered by a glob. Use this to find a file you do not know the exact path for.",
    "parameters":{"type":"object","required":[],"additionalProperties":false,
      "properties":{"glob":{"type":"string","description":"Optional pathspec glob, e.g. packages/contract-models/**."}}}}}
]'

# Reject absolute paths and any ".." segment before it ever reaches git —
# git show/grep/ls-tree take a pathspec, not a filesystem path, but a
# traversal-shaped string is rejected on principle rather than trusted to
# a pathspec parser we don't control.
_reject_traversal() {
  case "$1" in
    /*|*..*) return 1 ;;
    *) return 0 ;;
  esac
}

tool_read_file() {
  local path="$1" raw truncated
  if ! _reject_traversal "$path"; then
    printf 'error: invalid path'
    return 0
  fi
  if ! raw=$(timeout 10 git show "${PR_HEAD}:${path}" 2>/dev/null); then
    printf 'error: no such file at the PR head: %s' "$path"
    return 0
  fi
  truncated=$(printf '%s' "$raw" | head -c "$TOOL_OUTPUT_CAP")
  printf '%s' "$truncated"
  if [ "${#raw}" -gt "$TOOL_OUTPUT_CAP" ]; then
    printf '\n[truncated at %d bytes]' "$TOOL_OUTPUT_CAP"
  fi
}

tool_grep() {
  local pattern="$1" glob="${2:-}" result
  if [ -n "$glob" ]; then
    result=$(timeout 10 git grep -n -I -e "$pattern" "$PR_HEAD" -- "$glob" 2>&1) || true
  else
    result=$(timeout 10 git grep -n -I -e "$pattern" "$PR_HEAD" 2>&1) || true
  fi
  if [ -z "$result" ]; then
    printf 'no matches'
    return 0
  fi
  printf '%s' "$result" | head -c "$TOOL_OUTPUT_CAP"
}

tool_list_files() {
  local glob="${1:-}" result
  if [ -n "$glob" ]; then
    result=$(timeout 10 git ls-tree -r --name-only "$PR_HEAD" -- "$glob" 2>&1) || true
  else
    result=$(timeout 10 git ls-tree -r --name-only "$PR_HEAD" 2>&1) || true
  fi
  printf '%s' "$result" | head -c "$LIST_OUTPUT_CAP"
  if [ "${#result}" -gt "$LIST_OUTPUT_CAP" ]; then
    printf '\n[truncated — narrow with a glob]'
  fi
}

# Dispatches one {"name":..., "arguments": "<json string>"} tool_call object
# (as the raw JSON text) and prints its result as plain text. Every field
# extraction uses `VAR=$(...) || VAR=fallback` rather than a bare
# assignment specifically so a malformed tool call — bad JSON, a missing
# field — degrades to an "error: ..." string handed back to the model
# instead of aborting the whole review under the caller's `set -e`.
dispatch_tool_call() {
  local call_json="$1" name args out
  name=$(jq -r '.name' <<<"$call_json" 2>/dev/null) || name=""
  args=$(jq -r '.arguments' <<<"$call_json" 2>/dev/null) || args="{}"

  case "$name" in
    read_file)
      local path
      path=$(jq -r '.path // empty' <<<"$args" 2>/dev/null) || path=""
      if [ -z "$path" ]; then out="error: read_file requires a path"
      else out=$(tool_read_file "$path"); fi
      ;;
    grep)
      local pattern glob
      pattern=$(jq -r '.pattern // empty' <<<"$args" 2>/dev/null) || pattern=""
      glob=$(jq -r '.glob // empty' <<<"$args" 2>/dev/null) || glob=""
      if [ -z "$pattern" ]; then out="error: grep requires a pattern"
      else out=$(tool_grep "$pattern" "$glob"); fi
      ;;
    list_files)
      local glob
      glob=$(jq -r '.glob // empty' <<<"$args" 2>/dev/null) || glob=""
      out=$(tool_list_files "$glob")
      ;;
    *)
      out="error: unknown tool ${name:-<empty>}"
      ;;
  esac
  printf '%s' "$out"
}
