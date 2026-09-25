#!/bin/bash
# Watches PR 154 until it is merged or closed, then exits (one notification).
cd "$(dirname "$0")"
while true; do
  s=$(gh pr view 154 --json state -q .state 2>/dev/null || echo UNKNOWN)
  if [ "$s" = "MERGED" ] || [ "$s" = "CLOSED" ]; then
    echo "PR 154 state: $s"
    exit 0
  fi
  sleep 60
done
