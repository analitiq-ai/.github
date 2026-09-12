#!/usr/bin/env bash
set -euo pipefail
BASE="$1"
HEAD="$2"
BUDGET=100000
MAX_FILE=30000
EXCLUDES=(':!*.lock' ':!package-lock.json' ':!pnpm-lock.yaml' ':!yarn.lock'
          ':!*.min.*' ':!**/dist/*' ':!**/build/*' ':!**/vendor/*'
          ':!*.generated.*' ':!*_pb2.py' ':!*.snap')

# NUL-delimited and written to a file rather than `for f in $(...)`: a plain
# command substitution used as a for-loop word list drops its exit status,
# so a failing `git diff` here (bad BASE/HEAD) would otherwise go unnoticed
# and silently produce an empty "NO_CHANGES" diff instead of failing the job.
if ! git diff --name-only -z "$BASE"..."$HEAD" -- . "${EXCLUDES[@]}" > /tmp/changed-files.nul; then
  echo "::error::git diff failed to list changed files between $BASE and $HEAD"
  exit 1
fi

: > /tmp/diff.txt
SKIPPED=""
while IFS= read -r -d '' f; do
  SIZE=$(git diff "$BASE"..."$HEAD" -- "$f" | wc -c)
  CUR=$(wc -c < /tmp/diff.txt)
  if [ "$SIZE" -gt "$MAX_FILE" ] || [ $((CUR + SIZE)) -gt "$BUDGET" ]; then
    SKIPPED="$SKIPPED $f"; continue
  fi
  git diff "$BASE"..."$HEAD" -- "$f" >> /tmp/diff.txt
done < /tmp/changed-files.nul
[ -n "$SKIPPED" ] && echo "SKIPPED_FILES:$SKIPPED" >> /tmp/diff.txt
[ -s /tmp/diff.txt ] || echo "NO_CHANGES" > /tmp/diff.txt
