#!/bin/sh
set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIRECTORY/.." && pwd)
GRADLE_ROOT="$REPOSITORY_ROOT/sdks/android-feedback"
SOURCE_APK="$REPOSITORY_ROOT/apps/android/build/outputs/apk/release/missiongo-android-app-release.apk"
DOWNLOAD_DIRECTORY="$REPOSITORY_ROOT/apps/web/public/downloads"
LATEST_APK="$DOWNLOAD_DIRECTORY/missiongo-android-latest.apk"
TEMPORARY_APK="$DOWNLOAD_DIRECTORY/.missiongo-android-latest.apk.tmp"
RELEASE_METADATA="$DOWNLOAD_DIRECTORY/missiongo-android-latest.release"
GRADLE_PROPERTIES="$GRADLE_ROOT/gradle.properties"
MISSIONGO_CONFIG_DIRECTORY="${XDG_CONFIG_HOME:-"${HOME:?}/.config"}/missiongo"
PRODUCTION_ENV_FILE="$MISSIONGO_CONFIG_DIRECTORY/production.env"
SDK_TOKEN_FILE="$MISSIONGO_CONFIG_DIRECTORY/android-sdk-token.json"
SIGNING_PROPERTIES="$MISSIONGO_CONFIG_DIRECTORY/android-signing.properties"

if [ ! -f "$PRODUCTION_ENV_FILE" ] || [ ! -f "$SDK_TOKEN_FILE" ]; then
  echo "Missing private MissionGo Android publishing configuration." >&2
  exit 1
fi

# A published APK must be signed with the shared key, never with the machine's
# own debug keystore: Android refuses to upgrade an installed app across a
# change of signing key, so a build from a second workstation would strand
# everyone who installed the first one. Gradle falls back to the debug key for
# local development; publishing does not get that fallback.
if [ ! -f "$SIGNING_PROPERTIES" ]; then
  echo "Missing $SIGNING_PROPERTIES." >&2
  echo "Copy the private configuration directory from a machine that has it," >&2
  echo "or see apps/android/README.md to create the key for the first time." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$PRODUCTION_ENV_FILE"
set +a

MISSIONGO_ANDROID_ENDPOINT=${MISSIONGO_PUBLIC_ORIGIN:?Missing MISSIONGO_PUBLIC_ORIGIN}
MISSIONGO_ANDROID_SDK_TOKEN=$(jq -er '.token | select(type == "string" and length > 0)' "$SDK_TOKEN_FILE")
export MISSIONGO_ANDROID_ENDPOINT MISSIONGO_ANDROID_SDK_TOKEN

# The published APK is a release build. A debug build carries
# android:debuggable="true", which lets anyone holding the phone read the app's
# private data with run-as and attach a debugger to the signed-in WebView — too
# much for an APK on a public download link. Release builds became possible only
# once a shared signing key existed; before that they could not be installed as
# an upgrade.
BUILD_TIMESTAMP=$(date -u +%Y%m%d%H%M%S)
VERSION_CODE=$(date -u +%s)
# Declared once, in gradle.properties, so this script and a plain ./gradlew
# build cannot disagree about which version they are producing.
VERSION_NAME=$(sed -n 's/^missiongoAndroidVersionName=//p' "$GRADLE_PROPERTIES" | head -n 1)
if [ -z "$VERSION_NAME" ]; then
  echo "No missiongoAndroidVersionName in $GRADLE_PROPERTIES." >&2
  exit 1
fi

cd "$GRADLE_ROOT"
./gradlew \
  -PmissiongoAndroidVersionCode="$VERSION_CODE" \
  -PmissiongoAndroidVersionName="$VERSION_NAME" \
  -PmissiongoAndroidSigningProperties="$SIGNING_PROPERTIES" \
  :missiongo-android-app:assembleRelease

mkdir -p "$DOWNLOAD_DIRECTORY"
trap 'rm -f "$TEMPORARY_APK"' EXIT HUP INT TERM
cp "$SOURCE_APK" "$TEMPORARY_APK"
chmod 0644 "$TEMPORARY_APK"
mv "$TEMPORARY_APK" "$LATEST_APK"
trap - EXIT HUP INT TERM

# Record what was built beside the APK. The file is the only thing that knows
# which version the fixed-name APK holds, so scripts/deploy.sh can publish it
# under a versioned name instead of guessing one. Kept out of the Docker context
# by .dockerignore, so it is never served from /downloads/.
cat > "$RELEASE_METADATA" <<METADATA
version_name=$VERSION_NAME
version_code=$VERSION_CODE
build_timestamp=$BUILD_TIMESTAMP
sha256=$(shasum -a 256 "$LATEST_APK" | awk '{print $1}')
METADATA

cd "$REPOSITORY_ROOT"
npm run build:web

echo "Android internal build published: $VERSION_NAME ($VERSION_CODE)"
echo "Website path: /downloads/missiongo-android-latest.apk"
shasum -a 256 "$LATEST_APK"
