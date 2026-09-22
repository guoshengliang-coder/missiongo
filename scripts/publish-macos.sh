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
allow_ad_hoc=0
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-republish) allow_republish=1; shift ;;
    --allow-ad-hoc) allow_ad_hoc=1; shift ;;
    *) echo "Usage: $0 [--allow-republish] [--allow-ad-hoc]" >&2; exit 1 ;;
  esac
done

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIRECTORY/.." && pwd)
PACKAGE_DIRECTORY="$REPOSITORY_ROOT/apps/macos"
DOWNLOAD_DIRECTORY="$REPOSITORY_ROOT/apps/web/public/downloads"
LATEST_ZIP="$DOWNLOAD_DIRECTORY/missiongo-macos-latest.zip"
TEMPORARY_ZIP="$DOWNLOAD_DIRECTORY/.missiongo-macos-latest.zip.tmp"
RELEASE_METADATA="$DOWNLOAD_DIRECTORY/missiongo-macos-latest.release"
# What an installed client reads to decide whether it is out of date. Separate
# from the .release beside it on purpose: that one carries source_commit and
# source_dirty and is kept out of the web image by .dockerignore, so it can
# never answer this question. Both are written below from the same values.
UPDATE_MANIFEST="$DOWNLOAD_DIRECTORY/missiongo-macos-latest.json"

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

# Fail before testing/building/staging; never silently ship a development
# signature which cannot retain a stable identity across updates.
export MISSIONGO_MACOS_RELEASE=1
export MISSIONGO_MACOS_ALLOW_AD_HOC="$allow_ad_hoc"
sh "$SCRIPT_DIRECTORY/sign-macos-app.sh" --check-release-config

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

# Computed once and written to both files below, so the record a deploy checks
# and the manifest a client updates from can never disagree about this build.
BUILD_TIMESTAMP=$(date -u +%Y%m%d%H%M%S)
SHA256=$(shasum -a 256 "$LATEST_ZIP" | awk '{print $1}')
SIZE=$(wc -c < "$LATEST_ZIP" | tr -d ' ')
# Read back from the bundle rather than repeated here: build-macos-app.sh is the
# one place that decides which macOS versions this build runs on.
MINIMUM_SYSTEM_VERSION=$(plutil -extract LSMinimumSystemVersion raw "$PACKAGE_DIRECTORY/build/MissionGo.app/Contents/Info.plist")
RELEASE_NOTES=$(node "$REPOSITORY_ROOT/scripts/macos-release-notes.mjs" --to "$SOURCE_COMMIT")

# The zip has a fixed name, so this file is the only record of what is in it;
# scripts/deploy.sh refuses a zip whose digest no longer matches it.
cat > "$RELEASE_METADATA" <<METADATA
version=$VERSION
build_timestamp=$BUILD_TIMESTAMP
source_commit=$SOURCE_COMMIT
source_dirty=$SOURCE_DIRTY
signing_mode=$([ "$allow_ad_hoc" -eq 1 ] && echo adhoc || echo developer-id)
sha256=$SHA256
METADATA

# The public half: only what an installed client needs to decide whether to
# update and to check what it downloaded. No source_commit, no source_dirty --
# this file is served at /downloads/ and build provenance does not belong there.
cat > "$UPDATE_MANIFEST" <<MANIFEST
{
  "version": "$VERSION",
  "sha256": "$SHA256",
  "size": $SIZE,
  "buildTimestamp": "$BUILD_TIMESTAMP",
  "releaseNotes": $RELEASE_NOTES,
  "minimumSystemVersion": "$MINIMUM_SYSTEM_VERSION",
  "downloadPath": "/downloads/missiongo-macos-latest.zip"
}
MANIFEST
chmod 0644 "$UPDATE_MANIFEST"

if [ "$SOURCE_DIRTY" = "false" ]; then
  node "$REPOSITORY_ROOT/scripts/release-state.mjs" --record macosApp --commit "$SOURCE_COMMIT"
else
  echo "released.json not updated: this build came from a dirty tree, so no commit describes it." >&2
fi

echo "macOS client staged: ${VERSION}"
echo "Website path: /downloads/missiongo-macos-latest.zip (ships with the next deploy)"
echo "Update manifest: /downloads/missiongo-macos-latest.json"
shasum -a 256 "$LATEST_ZIP"
