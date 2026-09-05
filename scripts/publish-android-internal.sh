#!/bin/sh
set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIRECTORY/.." && pwd)
GRADLE_ROOT="$REPOSITORY_ROOT/sdks/android-feedback"
SOURCE_APK="$REPOSITORY_ROOT/apps/android/build/outputs/apk/debug/missiongo-android-app-debug.apk"
DOWNLOAD_DIRECTORY="$REPOSITORY_ROOT/apps/web/public/downloads"
LATEST_APK="$DOWNLOAD_DIRECTORY/missiongo-android-latest.apk"
TEMPORARY_APK="$DOWNLOAD_DIRECTORY/.missiongo-android-latest.apk.tmp"
MISSIONGO_CONFIG_DIRECTORY="${XDG_CONFIG_HOME:-"${HOME:?}/.config"}/missiongo"
PRODUCTION_ENV_FILE="$MISSIONGO_CONFIG_DIRECTORY/production.env"
SDK_TOKEN_FILE="$MISSIONGO_CONFIG_DIRECTORY/android-sdk-token.json"

if [ ! -f "$PRODUCTION_ENV_FILE" ] || [ ! -f "$SDK_TOKEN_FILE" ]; then
  echo "Missing private MissionGo Android publishing configuration." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$PRODUCTION_ENV_FILE"
set +a

MISSIONGO_ANDROID_ENDPOINT=${MISSIONGO_PUBLIC_ORIGIN:?Missing MISSIONGO_PUBLIC_ORIGIN}
MISSIONGO_ANDROID_SDK_TOKEN=$(jq -er '.token | select(type == "string" and length > 0)' "$SDK_TOKEN_FILE")
export MISSIONGO_ANDROID_ENDPOINT MISSIONGO_ANDROID_SDK_TOKEN

BUILD_TIMESTAMP=$(date -u +%Y%m%d%H%M%S)
VERSION_CODE=$(date -u +%s)
VERSION_NAME="0.1.7"

cd "$GRADLE_ROOT"
./gradlew \
  -PmissiongoAndroidVersionCode="$VERSION_CODE" \
  -PmissiongoAndroidVersionName="$VERSION_NAME" \
  :missiongo-android-app:assembleDebug

mkdir -p "$DOWNLOAD_DIRECTORY"
trap 'rm -f "$TEMPORARY_APK"' EXIT HUP INT TERM
cp "$SOURCE_APK" "$TEMPORARY_APK"
chmod 0644 "$TEMPORARY_APK"
mv "$TEMPORARY_APK" "$LATEST_APK"
trap - EXIT HUP INT TERM

cd "$REPOSITORY_ROOT"
npm run build:web

echo "Android internal build published: $VERSION_NAME"
echo "Website path: /downloads/missiongo-android-latest.apk"
shasum -a 256 "$LATEST_APK"
