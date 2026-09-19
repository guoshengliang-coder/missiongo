#!/bin/sh
# Development bundles may use ad-hoc signing. Releases default to Developer ID
# and notarization; an explicit --allow-ad-hoc publish is a documented exception.
# Credentials stay in
# the login keychain; only its profile name is supplied here.
set -eu

check_release_config() {
  case "${MISSIONGO_MACOS_ALLOW_AD_HOC:-0}" in
    1) echo "Warning: explicitly publishing without Developer ID/notarization; system permissions may be requested again after updates." >&2; return ;;
    0) ;;
    *) echo "MISSIONGO_MACOS_ALLOW_AD_HOC must be 0 or 1." >&2; exit 1 ;;
  esac
  case "${MISSIONGO_MACOS_SIGNING_IDENTITY:-}" in
    "Developer ID Application: "?*) ;;
    *) echo "Release requires MISSIONGO_MACOS_SIGNING_IDENTITY (Developer ID Application certificate)." >&2; exit 1 ;;
  esac
  if [ -z "${MISSIONGO_MACOS_NOTARY_PROFILE:-}" ]; then
    echo "Release requires MISSIONGO_MACOS_NOTARY_PROFILE (notarytool keychain profile)." >&2
    exit 1
  fi
}

if [ "${1:-}" = "--check-release-config" ]; then check_release_config; exit 0; fi
[ "$#" -eq 2 ] || { echo "Usage: sign-macos-app.sh <app> <zip>" >&2; exit 1; }
app="$1"
archive="$2"
release="${MISSIONGO_MACOS_RELEASE:-0}"
case "$release" in 0|1) ;; *) echo "MISSIONGO_MACOS_RELEASE must be 0 or 1." >&2; exit 1 ;; esac
if [ "$release" = 1 ]; then check_release_config; fi

identity="${MISSIONGO_MACOS_SIGNING_IDENTITY:--}"
if [ "${MISSIONGO_MACOS_ALLOW_AD_HOC:-0}" = 1 ]; then identity=-; fi
if [ "$identity" = - ]; then
  echo "==> Ad-hoc signature (no Developer ID or notarization)"
  codesign --force --sign - --timestamp=none "$app"
else
  echo "==> Signing with configured certificate"
  codesign --force --sign "$identity" --options runtime --timestamp "$app"
fi
codesign --verify --deep --strict "$app"
ditto -c -k --keepParent "$app" "$archive"

if [ "$release" = 1 ] && [ "${MISSIONGO_MACOS_ALLOW_AD_HOC:-0}" != 1 ]; then
  receipt=$(mktemp)
  trap 'rm -f "$receipt"' EXIT HUP INT TERM
  xcrun notarytool submit "$archive" --keychain-profile "$MISSIONGO_MACOS_NOTARY_PROFILE" --wait --output-format json > "$receipt"
  node -e 'const fs = require("node:fs"); const receipt = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (receipt.status !== "Accepted") { console.error("Notarization was not accepted:", receipt.status); process.exit(1); }' "$receipt"
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  spctl --assess --type execute "$app"
  # ZIPs cannot be stapled. Package the app again with its ticket attached.
  ditto -c -k --keepParent "$app" "$archive"
fi
