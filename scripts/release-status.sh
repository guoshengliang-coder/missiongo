#!/usr/bin/env bash
# Sourced from the guarded deploy shell, after coverage validation. The status
# directory is outside containers and releases; the host nginx owns its route.
release_status_started=0
release_status_directory="${MISSIONGO_RELEASE_STATUS_DIRECTORY:-/var/lib/missiongo-release-status}"
release_status_write() {
  local phase="$1" expires="$2" token="${3:-$commit}"
  [[ "$release_status_directory" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Invalid release status directory.' >&2; return 1; }
  [[ "$token" =~ ^[a-zA-Z0-9-]+$ ]] || return 1
  # No mkdir here: missing host provisioning must fail before service switching.
  remote "printf '%s\n' '{\"version\":1,\"phase\":\"${phase}\",\"expiresAt\":${expires},\"release\":\"${token}\"}' | sudo tee '${release_status_directory}/status.next' >/dev/null && sudo mv '${release_status_directory}/status.next' '${release_status_directory}/status.json'"
}
release_status_probe() {
  [ -n "${notice_origin:-}" ] || { echo 'Upgrade status requires --notice-origin.' >&2; return 1; }
  local token="probe-$(date -u +%s)-$$" observed
  release_status_write idle 0 "$token" || return 1
  observed="$(curl --fail --silent --show-error --max-time 10 "${notice_origin%/}/release-status.json?probe=${token}")" || return 1
  node -e 'const s=JSON.parse(process.argv[1]);if(s.version!==1||s.phase!=="idle"||s.release!==process.argv[2])process.exit(1)' "$observed" "$token" || {
    echo 'Host release status route is missing or cached; provision it before deploying.' >&2; return 1;
  }
}
release_status_begin() {
  release_status_probe || return 1
  release_status_started=1
  release_status_write upgrading "$(( $(date -u +%s) * 1000 + 600000 ))" || return 1
  # Visible clients poll every 5s. Announce before interrupting their API calls.
  sleep 10
}
release_status_complete() {
  local health
  health="$(curl --fail --silent --show-error --max-time 15 "${notice_origin%/}/health")" || return 1
  node -e 'const s=JSON.parse(process.argv[1]);if(s.status!=="ok"||s.release!==process.argv[2])process.exit(1)' "$health" "$commit" || return 1
  release_status_write idle 0
  release_status_started=0
}
release_status_finish() {
  if [ "$release_status_started" -eq 1 ]; then
    release_status_write failed "$(( $(date -u +%s) * 1000 + 600000 ))" || echo 'Could not record deployment failure; status will expire.' >&2
  fi
}
