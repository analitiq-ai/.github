#!/usr/bin/env bash
set -euo pipefail
BASE="$1"
HEAD="$2"
BUDGET=100000
MAX_FILE=30000
EXCLUDES=(':!*.lock' ':!package-lock.json' ':!pnpm-lock.yaml' ':!yarn.lock'
          ':!*.min.*' ':!dist/*' ':!build/*' ':!vendor/*'
          ':!*.generated.*' ':!*_pb2.py' ':!*.snap')

: > /tmp/diff.txt
SKIPPED=""
for f in $(git diff --name-only "$BASE"..."$HEAD" -- . "${EXCLUDES[@]}"); do
  SIZE=$(git diff "$BASE"..."$HEAD" -- "$f" | wc -c)
  CUR=$(wc -c < /tmp/diff.txt)
  if [ "$SIZE" -gt "$MAX_FILE" ] || [ $((CUR + SIZE)) -gt "$BUDGET" ]; then
    SKIPPED="$SKIPPED $f"; continue
  fi
  git diff "$BASE"..."$HEAD" -- "$f" >> /tmp/diff.txt
done
[ -n "$SKIPPED" ] && echo "SKIPPED_FILES:$SKIPPED" >> /tmp/diff.txt
[ -s /tmp/diff.txt ] || echo "NO_CHANGES" > /tmp/diff.txt
