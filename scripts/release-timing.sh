#!/usr/bin/env bash
# Sourced by the deploy shell. No commands/arguments/hosts enter the report.
release_timing_start() {
  RELEASE_TIMING_ENABLED=0
  RELEASE_TIMING_NAMES=()
  RELEASE_TIMING_DURATIONS=()
  RELEASE_TIMING_RESULTS=()
  RELEASE_TIMING_PHASE=""
  RELEASE_TIMING_COUNT=0
  RELEASE_TIMING_START=$SECONDS
  RELEASE_TIMING_OWNER="$$:$BASH_SUBSHELL"
  local directory="${MISSIONGO_RELEASE_TIMING_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/missiongo/release-timings}"
  if ! mkdir -p "$directory"; then
    echo 'Warning: release timing directory is unavailable.' >&2
    return 0
  fi
  RELEASE_TIMING_OUTPUT="$directory/release-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
  if ! (umask 077; set -C; : > "$RELEASE_TIMING_OUTPUT"); then
    echo 'Warning: release timing report could not be created.' >&2
    return 0
  fi
  RELEASE_TIMING_ENABLED=1
  trap 'release_timing_finish "$?"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

release_timing_end() {
  [ "${RELEASE_TIMING_ENABLED:-0}" -eq 1 ] || return 0
  [ -n "$RELEASE_TIMING_PHASE" ] || return 0
  RELEASE_TIMING_NAMES+=("$RELEASE_TIMING_PHASE")
  RELEASE_TIMING_DURATIONS+=("$((SECONDS - RELEASE_TIMING_PHASE_START))")
  RELEASE_TIMING_RESULTS+=("$1")
  RELEASE_TIMING_COUNT=$((RELEASE_TIMING_COUNT + 1))
  RELEASE_TIMING_PHASE=""
}

release_timing_stage() {
  [ "${RELEASE_TIMING_ENABLED:-0}" -eq 1 ] || return 0
  release_timing_end passed
  case "$1" in ""|*[!a-z0-9_]*) return 2 ;; esac
  RELEASE_TIMING_PHASE="$1"
  RELEASE_TIMING_PHASE_START=$SECONDS
}

release_timing_skip() {
  [ "${RELEASE_TIMING_ENABLED:-0}" -eq 1 ] || return 0
  release_timing_stage "$1"
  release_timing_end skipped
}

release_timing_finish() {
  local result="$1" phase_result=passed i comma="" recorded_commit=null payload
  # Never let a command substitution/subshell finish the parent's report.
  [ "${RELEASE_TIMING_ENABLED:-0}" -eq 1 ] && [ "$$:$BASH_SUBSHELL" = "$RELEASE_TIMING_OWNER" ] || return 0
  trap - EXIT
  [ "$result" -eq 0 ] || phase_result=failed
  release_timing_end "$phase_result"
  if [[ "${commit:-}" =~ ^[a-f0-9]{40}$ ]]; then recorded_commit="\"$commit\""; fi
  payload="$(
    printf '{"version":1,"commit":%s,"exitCode":%s,"durationSeconds":%s,"stages":[' "$recorded_commit" "$result" "$((SECONDS - RELEASE_TIMING_START))"
    for ((i=0; i<RELEASE_TIMING_COUNT; i++)); do
      printf '%s{"name":"%s","durationSeconds":%s,"status":"%s"}' "$comma" "${RELEASE_TIMING_NAMES[$i]}" "${RELEASE_TIMING_DURATIONS[$i]}" "${RELEASE_TIMING_RESULTS[$i]}"
      comma=,
    done
    printf ']}\n'
  )"
  if ! printf '%s\n' "$payload" > "$RELEASE_TIMING_OUTPUT"; then
    echo 'Warning: release timing report could not be written.' >&2
  else
    echo "==> Release timing: $RELEASE_TIMING_OUTPUT (exit $result)" >&2
    for ((i=0; i<RELEASE_TIMING_COUNT; i++)); do
      printf '    %s: %ss (%s)\n' "${RELEASE_TIMING_NAMES[$i]}" "${RELEASE_TIMING_DURATIONS[$i]}" "${RELEASE_TIMING_RESULTS[$i]}" >&2
    done
  fi
  # EXIT trap leaves the deployment's original status intact, including failure.
  return 0
}
