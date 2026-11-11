# Sourced by deploy.sh under its existing set -euo pipefail and release lock.
check_release_coverage() {
  local coverage_tools="${MISSIONGO_RELEASE_TOOLS:?Use missiongo-release}"
  local coverage_args=(--root "$PWD" --snapshot "$before_snapshot" --host "$host" --current-link "$current_link"
    --coverage-config "${MISSIONGO_RELEASE_COVERAGE_CONFIG:?Missing product/repository binding}"
    --candidates "${MISSIONGO_RELEASE_CANDIDATES:?Missing complete release candidates}")
  [ "$publish_apk" -eq 1 ] || coverage_args+=(--no-publish-apk)
  if [ -n "${MISSIONGO_RELEASE_SELECTION:-}" ]; then
    coverage_args+=(--selection "$MISSIONGO_RELEASE_SELECTION")
  fi
  if [ -n "${MISSIONGO_RELEASE_ONLY_ARTIFACTS:-}" ]; then
    coverage_args+=(--only-artifacts "$MISSIONGO_RELEASE_ONLY_ARTIFACTS" --scope-reason "${MISSIONGO_RELEASE_SCOPE_REASON:?Missing explicit user scope}")
  fi
  node "$coverage_tools/release-preflight.mjs" "${coverage_args[@]}"
}

reconcile_release_coverage() {
  local coverage_tools="${MISSIONGO_RELEASE_TOOLS:?Use missiongo-release}"
  local coverage_args=(--root "$PWD" --receipt-json "$1"
    --coverage-config "${MISSIONGO_RELEASE_COVERAGE_CONFIG:?Missing product/repository binding}"
    --candidates "${MISSIONGO_RELEASE_CANDIDATES:?Missing complete release candidates}")
  if [ -n "${MISSIONGO_RELEASE_SELECTION:-}" ]; then
    coverage_args+=(--selection "$MISSIONGO_RELEASE_SELECTION")
  fi
  if [ -n "${MISSIONGO_RELEASE_ONLY_ARTIFACTS:-}" ]; then
    coverage_args+=(--only-artifacts "$MISSIONGO_RELEASE_ONLY_ARTIFACTS" --scope-reason "${MISSIONGO_RELEASE_SCOPE_REASON:?Missing explicit user scope}")
  fi
  echo "==> Release coverage reconciliation (JSON; item handover and notification are checked separately)"
  node "$coverage_tools/release-coverage.mjs" "${coverage_args[@]}" || {
    echo "Deployment finished, but requested delivery coverage is incomplete; retain the receipt and report every missing item." >&2
    return 1
  }
}
