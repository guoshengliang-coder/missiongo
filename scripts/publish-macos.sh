#!/bin/sh
#
# Build the macOS client and stage it for the next deploy.
#
#   npm run publish:macos [-- --allow-republish]
#
# Mirrors publish-android-internal.sh: refuse a version number that would come to
# mean two builds, test, build, place the zip where the web image picks it up,
# record which commit it was built from.
set -eu

allow_republish=0
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-republish) allow_republish=1; shift ;;
    *) echo "Usage: $0 [--allow-republish]" >&2; exit 1 ;;
  esac
done

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIRECTORY/.." && pwd)
PACKAGE_DIRECTORY="$REPOSITORY_ROOT/apps/macos"
DOWNLOAD_DIRECTORY="$REPOSITORY_ROOT/apps/web/public/downloads"
LATEST_ZIP="$DOWNLOAD_DIRECTORY/missiongo-macos-latest.zip"
TEMPORARY_ZIP="$DOWNLOAD_DIRECTORY/.missiongo-macos-latest.zip.tmp"
RELEASE_METADATA="$DOWNLOAD_DIRECTORY/missiongo-macos-latest.release"

# The published app must point at the real deployment, which lives only in the
# private configuration beside the Android publishing files.
PRODUCTION_ENV_FILE="${XDG_CONFIG_HOME:-"${HOME:?}/.config"}/missiongo/production.env"
if [ ! -f "$PRODUCTION_ENV_FILE" ]; then
  echo "Missing $PRODUCTION_ENV_FILE (it supplies MISSIONGO_PUBLIC_ORIGIN)." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$PRODUCTION_ENV_FILE"
set +a
: "${MISSIONGO_PUBLIC_ORIGIN:?Missing MISSIONGO_PUBLIC_ORIGIN in $PRODUCTION_ENV_FILE}"
export MISSIONGO_PUBLIC_ORIGIN

if [ "$allow_republish" -eq 0 ]; then
  node "$REPOSITORY_ROOT/scripts/release-state.mjs" --check macosApp || {
    echo "Pass --allow-republish to publish anyway." >&2
    exit 1
  }
fi

SOURCE_COMMIT=$(git -C "$REPOSITORY_ROOT" rev-parse HEAD)
SOURCE_DIRTY=false
if [ -n "$(git -C "$REPOSITORY_ROOT" status --porcelain)" ]; then
  SOURCE_DIRTY=true
  echo "Note: publishing from a working tree with uncommitted changes." >&2
  echo "      The zip will record source_dirty=true, so it can never be mistaken" >&2
  echo "      for a build of ${SOURCE_COMMIT}." >&2
fi

echo "==> Testing"
swift test --package-path "$PACKAGE_DIRECTORY"

"$REPOSITORY_ROOT/scripts/build-macos-app.sh"

VERSION=$(sed -n 's/^missiongoMacosVersion=//p' "$PACKAGE_DIRECTORY/version.properties" | head -n 1)
mkdir -p "$DOWNLOAD_DIRECTORY"
trap 'rm -f "$TEMPORARY_ZIP"' EXIT HUP INT TERM
cp "$PACKAGE_DIRECTORY/build/MissionGo-macOS.zip" "$TEMPORARY_ZIP"
chmod 0644 "$TEMPORARY_ZIP"
mv "$TEMPORARY_ZIP" "$LATEST_ZIP"
trap - EXIT HUP INT TERM

# The zip has a fixed name, so this file is the only record of what is in it;
# scripts/deploy.sh refuses a zip whose digest no longer matches it.
cat > "$RELEASE_METADATA" <<METADATA
version=$VERSION
build_timestamp=$(date -u +%Y%m%d%H%M%S)
source_commit=$SOURCE_COMMIT
source_dirty=$SOURCE_DIRTY
sha256=$(shasum -a 256 "$LATEST_ZIP" | awk '{print $1}')
METADATA

if [ "$SOURCE_DIRTY" = "false" ]; then
  node "$REPOSITORY_ROOT/scripts/release-state.mjs" --record macosApp --commit "$SOURCE_COMMIT"
else
  echo "released.json not updated: this build came from a dirty tree, so no commit describes it." >&2
fi

echo "macOS client staged: ${VERSION}"
echo "Website path: /downloads/missiongo-macos-latest.zip (ships with the next deploy)"
shasum -a 256 "$LATEST_ZIP"
