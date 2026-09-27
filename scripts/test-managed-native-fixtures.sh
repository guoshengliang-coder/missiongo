#!/bin/sh
# Compile existing XCTest fixtures directly when nested SwiftPM manifest sandboxing
# is unavailable. Does not disable any sandbox or launch a native business Agent.
set -eu
: "${TMPDIR:?Set TMPDIR to a writable temporary directory}"
: "${MANAGED_WIRE_FIXTURE:?First generate the actual HTTP response with the managed-execution server test}"
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dev=${DEVELOPER_DIR:-$(xcode-select -p)}
platform="$dev/Platforms/MacOSX.platform/Developer"
compiler="$dev/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc"
out=$(mktemp -d "$TMPDIR/and232-swift.XXXXXX")
trap 'rm -rf "$out"' EXIT HUP INT TERM
cd "$repo_root"
"$compiler" -sdk "$platform/SDKs/MacOSX.sdk" -target arm64-apple-macosx14.0 \
  -module-cache-path "$out/cache" -emit-library -emit-module -enable-testing -module-name MissionGoNodeCore \
  apps/macos/Sources/MissionGoNodeCore/*.swift -o "$out/libMissionGoNodeCore.dylib" \
  -emit-module-path "$out/MissionGoNodeCore.swiftmodule"
cat > "$out/main.swift" <<'SWIFT'
import XCTest
let suite = XCTestSuite(name: "Managed and manual Node regressions")
suite.addTest(ManagedExecutionTests.defaultTestSuite)
suite.addTest(NodeLoopTests.defaultTestSuite)
suite.addTest(APIClientTests.defaultTestSuite)
let selected = XCTestSuite(name: "Selected regressions")
for group in suite.tests {
    for test in (group as! XCTestSuite).tests {
        if let filter = ProcessInfo.processInfo.environment["MANAGED_TEST_FILTER"], !test.name.contains(filter) { continue }
        selected.addTest(test)
    }
}
selected.run()
exit(selected.testRun!.hasSucceeded && selected.testRun!.executionCount > 0 ? 0 : 1)
SWIFT
"$compiler" -sdk "$platform/SDKs/MacOSX.sdk" -target arm64-apple-macosx14.0 \
  -F "$platform/Library/Frameworks" -I "$platform/usr/lib" -L "$platform/usr/lib" \
  -module-cache-path "$out/cache" -I "$out" -L "$out" -lMissionGoNodeCore \
  -Xlinker -rpath -Xlinker "$out" \
  -Xlinker -rpath -Xlinker "$platform/Library/Frameworks" \
  -Xlinker -rpath -Xlinker "$platform/usr/lib" \
  apps/macos/Tests/MissionGoNodeCoreTests/ManagedExecutionTests.swift \
  apps/macos/Tests/MissionGoNodeCoreTests/NodeLoopTests.swift \
  apps/macos/Tests/MissionGoNodeCoreTests/APIClientTests.swift \
  apps/macos/Tests/MissionGoNodeCoreTests/StubURLProtocol.swift \
  "$out/main.swift" -o "$out/tests"
DYLD_FRAMEWORK_PATH="$platform/Library/PrivateFrameworks" "$out/tests"

if [ "${MANAGED_PROCESS_FIXTURES:-0}" = 1 ]; then
  "$compiler" -sdk "$platform/SDKs/MacOSX.sdk" -target arm64-apple-macosx14.0 \
    -module-cache-path "$out/cache" -I "$out" -L "$out" -lMissionGoNodeCore \
    -Xlinker -rpath -Xlinker "$out" \
    scripts/fixtures/managed-terminal-process.swift \
    apps/macos/Tests/MissionGoNodeCoreTests/StubURLProtocol.swift -o "$out/terminal-process"
  MANAGED_PROCESS_EXECUTABLE="$out/terminal-process" npm run test --workspace @missiongo/server -- \
    src/managed-execution-closeout.test.ts -t 'native process'
fi
