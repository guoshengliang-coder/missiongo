#!/bin/sh
set -eu
[ -n "${MISSIONGO_COORDINATOR_ENTRY:-}" ] && [ -n "${MISSIONGO_RELEASE_LOCK_FD:-}" ] || {
  echo 'Use missiongo-release publish:windows after installing Windows release support.' >&2
  exit 1
}
exec node "$(dirname "$0")/publish-windows.mjs"
