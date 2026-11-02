#!/bin/sh
set -eu
# Only the shared coordinator may stage a production artifact. Ordinary builds
# and package tests use build-node.mjs without changing publication records.
[ -n "${MISSIONGO_COORDINATOR_ENTRY:-}" ] && [ -n "${MISSIONGO_RELEASE_LOCK_FD:-}" ] || {
  echo 'Use missiongo-release publish:linux (install support with node scripts/enable-linux-release.mjs).' >&2
  exit 1
}
exec node "$(dirname "$0")/publish-linux.mjs"
