#!/usr/bin/env sh
#
# Publish the Android feedback SDK into the website's Maven tree.
#
#   ./scripts/publish-android-sdk.sh
#   ./scripts/publish-android-sdk.sh --allow-republish
#
# The Gradle build already refuses to overwrite a version directory that exists,
# but that directory is gitignored: on a fresh clone it is absent, the check
# passes, and an already-published version is silently rebuilt. What has actually
# been released has to be recorded somewhere that travels with the repository,
# which is what released.json is for.
#
# The artifacts land in apps/web/public/maven and reach the site with the next
# deployment, so publishing here is a local step, not a remote one.

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
GRADLE_ROOT="$REPOSITORY_ROOT/sdks/android-feedback"

if [ "$allow_republish" -eq 0 ]; then
  node "$REPOSITORY_ROOT/scripts/release-state.mjs" --check androidSdk || {
    echo "Pass --allow-republish to publish anyway." >&2
    exit 1
  }
fi

SOURCE_COMMIT=$(git -C "$REPOSITORY_ROOT" rev-parse HEAD)
SOURCE_DIRTY=false
if [ -n "$(git -C "$REPOSITORY_ROOT" status --porcelain)" ]; then
  SOURCE_DIRTY=true
  echo "Note: publishing from a working tree with uncommitted changes." >&2
fi

cd "$GRADLE_ROOT"
if [ "$allow_republish" -eq 1 ]; then
  ./gradlew -PmissiongoAllowRepublish=true :missiongo-feedback:publishReleasePublicationToWebsiteRepository
else
  ./gradlew :missiongo-feedback:publishReleasePublicationToWebsiteRepository
fi

cd "$REPOSITORY_ROOT"
if [ "$SOURCE_DIRTY" = "false" ]; then
  node "$REPOSITORY_ROOT/scripts/release-state.mjs" --record androidSdk --commit "$SOURCE_COMMIT"
else
  echo "released.json not updated: this build came from a dirty tree, so no commit describes it." >&2
fi

echo "SDK published into apps/web/public/maven. It reaches the site with the next deploy."
