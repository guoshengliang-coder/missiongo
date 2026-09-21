#!/bin/sh
#
# Build MissionGo.app from the Swift package in apps/macos and zip it.
#
#   scripts/build-macos-app.sh            # writes apps/macos/build/MissionGo.app and MissionGo-macOS.zip
#
# There is no Xcode project on purpose. A hand-edited project.pbxproj is where
# merges go to die, and the package builds, tests and runs in CI with nothing but
# the command-line tools. The one thing SwiftPM does not do is wrap an executable
# in an app bundle, so this script does that part.
#
# CI/development builds may be signed ad hoc. The publisher sets
# MISSIONGO_MACOS_RELEASE=1, requiring Developer ID signing and notarization.
set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIRECTORY/.." && pwd)
PACKAGE_DIRECTORY="$REPOSITORY_ROOT/apps/macos"
BUILD_DIRECTORY="$PACKAGE_DIRECTORY/build"
APP="$BUILD_DIRECTORY/MissionGo.app"
ZIP="$BUILD_DIRECTORY/MissionGo-macOS.zip"
EXECUTABLE=MissionGo
CLAUDE_HOST_EXECUTABLE=MissionGoClaudeHost
ALLOW_AD_HOC_UPDATES=false
if [ "${MISSIONGO_MACOS_ALLOW_AD_HOC:-0}" = 1 ]; then ALLOW_AD_HOC_UPDATES=true; fi

# Declared once, like the Android version name, so the bundle and released.json
# cannot disagree about which version this is.
VERSION=$(sed -n 's/^missiongoMacosVersion=//p' "$PACKAGE_DIRECTORY/version.properties" | head -n 1)
case "$VERSION" in ""|*[!0-9.]*) echo "Bad missiongoMacosVersion in apps/macos/version.properties: '$VERSION'" >&2; exit 1 ;; esac

BUNDLE_IDENTIFIER=$(node -e "process.stdout.write(require('$REPOSITORY_ROOT/product.json').macos.app.bundleIdentifier)")
PRODUCT_NAME=$(node -e "process.stdout.write(require('$REPOSITORY_ROOT/product.json').macos.app.label)")
# The build number only has to increase, and a timestamp does without a counter
# someone has to remember to bump.
BUILD_NUMBER=$(date -u +%Y%m%d%H%M)

# The deployment the app signs in to. Supplied at build time, never committed
# (AGENTS.md: no real domains in tracked files), the same way the Android app
# gets its endpoint. A build without one still runs; the person enters the
# address on the sign-in screen instead.
SERVER_URL=${MISSIONGO_PUBLIC_ORIGIN:-https://example.invalid}
case "$SERVER_URL" in
  http://*|https://*) ;;
  *) echo "MISSIONGO_PUBLIC_ORIGIN must be an http(s) origin, got '$SERVER_URL'" >&2; exit 1 ;;
esac
SERVER_URL=${SERVER_URL%/}

echo "==> Building ${PRODUCT_NAME} ${VERSION} (${BUILD_NUMBER})"
# Universal, so the same download runs on an Intel Mac mini and an Apple silicon
# laptop without the person having to know which one they have.
swift build --package-path "$PACKAGE_DIRECTORY" -c release --arch arm64 --arch x86_64
BINARY_DIRECTORY=$(swift build --package-path "$PACKAGE_DIRECTORY" -c release --arch arm64 --arch x86_64 --show-bin-path)

rm -rf "$APP" "$ZIP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BINARY_DIRECTORY/$EXECUTABLE" "$APP/Contents/MacOS/$EXECUTABLE"
cp "$BINARY_DIRECTORY/$CLAUDE_HOST_EXECUTABLE" "$APP/Contents/MacOS/$CLAUDE_HOST_EXECUTABLE"
# SwiftPM puts package resources in sibling .bundle directories; the executable
# looks for them inside its own bundle once it is wrapped.
for resource_bundle in "$BINARY_DIRECTORY"/*.bundle; do
  [ -e "$resource_bundle" ] && cp -R "$resource_bundle" "$APP/Contents/Resources/"
done

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_IDENTIFIER}</string>
  <key>CFBundleName</key><string>${PRODUCT_NAME}</string>
  <key>CFBundleDisplayName</key><string>${PRODUCT_NAME}</string>
  <key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <!-- A menu-bar app: no Dock icon, no main window to close by accident. -->
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>MissionGoServerURL</key><string>${SERVER_URL}</string>
  <key>MissionGoAllowsAdHocUpdates</key><${ALLOW_AD_HOC_UPDATES}/>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null

# The app icon comes from the one product icon the web app and Android use.
# Quick Look renders the SVG; without it the app still works and Finder shows a
# generic icon, which is not worth failing a build over.
ICON_SOURCE="$REPOSITORY_ROOT/$(node -e "process.stdout.write(require('$REPOSITORY_ROOT/product.json').icon)")"
ICON_WORK=$(mktemp -d)
trap 'rm -rf "$ICON_WORK"' EXIT HUP INT TERM
if qlmanage -t -s 1024 -o "$ICON_WORK" "$ICON_SOURCE" >/dev/null 2>&1 && [ -s "$ICON_WORK/$(basename "$ICON_SOURCE").png" ]; then
  ICONSET="$ICON_WORK/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$ICON_WORK/$(basename "$ICON_SOURCE").png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$ICON_WORK/$(basename "$ICON_SOURCE").png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
else
  echo "Note: could not render ${ICON_SOURCE}; the app will use a generic icon." >&2
fi

sh "$SCRIPT_DIRECTORY/sign-macos-app.sh" "$APP" "$ZIP"
echo "==> ${ZIP}"
shasum -a 256 "$ZIP"
