import XCTest
@testable import MissionGoNodeCore

private func temporaryDirectory() throws -> URL {
    let url = URL(fileURLWithPath: "/tmp/mg-update-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

private func manifestJSON(
    version: String = "0.4.0",
    sha256: String = String(repeating: "a", count: 64),
    size: Int = 1234,
    downloadPath: String = "/downloads/missiongo-macos-latest.zip"
) -> String {
    return """
    {"version":"\(version)","sha256":"\(sha256)","size":\(size),\
    "buildTimestamp":"20260915033846","minimumSystemVersion":"13.0",\
    "downloadPath":"\(downloadPath)"}
    """
}

final class VersionTests: XCTestCase {
    func testComparesPartByPartAsNumbers() {
        XCTAssertTrue(Version.isNewer("0.10.0", than: "0.9.0"))
        XCTAssertTrue(Version.isNewer("0.3.2", than: "0.3.1"))
        XCTAssertTrue(Version.isNewer("1.0", than: "0.9.9"))
        XCTAssertFalse(Version.isNewer("0.3.1", than: "0.3.1"))
        XCTAssertFalse(Version.isNewer("0.3.1", than: "0.4.0"))
    }

    func testTreatsMissingPartsAsZero() {
        XCTAssertFalse(Version.isNewer("5.3", than: "5.3.0"))
        XCTAssertFalse(Version.isNewer("5.3.0", than: "5.3"))
        XCTAssertTrue(Version.isNewer("5.3.1", than: "5.3"))
    }

    /// Refusing to act beats guessing which unreadable version is newer.
    func testUnreadableVersionsAreNeverNewer() {
        XCTAssertFalse(Version.isNewer("0.4.0-beta", than: "0.3.1"))
        XCTAssertFalse(Version.isNewer("0.4.0", than: "not a version"))
        XCTAssertFalse(Version.isNewer("", than: "0.3.1"))
        XCTAssertNil(Version.numericParts("<!doctype html>"))
    }

    /// The Skill sync and the app updater must not drift into two orderings.
    func testSkillSyncUsesTheSameComparison() {
        XCTAssertEqual(SkillSync.isNewer("5.10.0", than: "5.9.0"), Version.isNewer("5.10.0", than: "5.9.0"))
        XCTAssertTrue(SkillSync.isNewer("5.10.0", than: "5.9.0"))
    }
}

final class AppUpdaterManifestTests: XCTestCase {
    func testReadsAPublishedManifest() throws {
        let manifest = try AppUpdater.decode(manifest: Data(manifestJSON().utf8))
        XCTAssertEqual(manifest.version, "0.4.0")
        XCTAssertEqual(manifest.size, 1234)
        XCTAssertEqual(manifest.downloadPath, "/downloads/missiongo-macos-latest.zip")
        XCTAssertEqual(manifest.minimumSystemVersion, "13.0")
    }

    /// The console's index.html is what a misconfigured server actually returns.
    func testRefusesAnythingThatIsNotTheManifest() {
        for body in ["<!doctype html><html></html>", "", "{}", "{\"version\":\"0.4.0\"}"] {
            XCTAssertThrowsError(try AppUpdater.decode(manifest: Data(body.utf8)), body) { error in
                guard case .badManifest = error as? AppUpdater.UpdateError ?? .digestMismatch else {
                    return XCTFail("expected badManifest for \(body), got \(error)")
                }
            }
        }
    }

    func testRefusesUnusableFields() {
        let cases = [
            manifestJSON(version: "latest"),
            manifestJSON(sha256: "nothex"),
            manifestJSON(sha256: String(repeating: "A", count: 64)),
            manifestJSON(size: 0),
            manifestJSON(downloadPath: "https://elsewhere.invalid/app.zip"),
            manifestJSON(downloadPath: "//elsewhere.invalid/app.zip"),
        ]
        for body in cases {
            XCTAssertThrowsError(try AppUpdater.decode(manifest: Data(body.utf8)), body)
        }
    }

    func testOffersOnlyANewerBuild() async throws {
        StubURLProtocol.install { _, _ in .response(status: 200, body: manifestJSON(version: "0.4.0")) }
        let session = StubURLProtocol.session()

        let found = try await AppUpdater.check(serverUrl: "https://s.invalid", currentVersion: "0.3.1", session: session)
        XCTAssertEqual(found?.manifest.version, "0.4.0")
        XCTAssertEqual(found?.current, "0.3.1")

        let same = try await AppUpdater.check(serverUrl: "https://s.invalid", currentVersion: "0.4.0", session: session)
        XCTAssertNil(same)
        let ahead = try await AppUpdater.check(serverUrl: "https://s.invalid", currentVersion: "0.5.0", session: session)
        XCTAssertNil(ahead)
    }

    func testAsksTheServerThisMacIsSignedInTo() async throws {
        StubURLProtocol.install { _, _ in .response(status: 200, body: manifestJSON()) }
        _ = try await AppUpdater.check(
            serverUrl: "https://s.invalid", currentVersion: "0.3.1", session: StubURLProtocol.session()
        )
        XCTAssertEqual(
            StubURLProtocol.recorded.last?.request.url?.absoluteString,
            "https://s.invalid/downloads/missiongo-macos-latest.json"
        )
    }

    func testReportsAServerThatWillNotAnswer() async {
        StubURLProtocol.install { _, _ in .response(status: 503, body: "") }
        do {
            _ = try await AppUpdater.check(
                serverUrl: "https://s.invalid", currentVersion: "0.3.1", session: StubURLProtocol.session()
            )
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? AppUpdater.UpdateError, .download("HTTP 503"))
        }
    }
}

final class AppUpdaterDownloadTests: XCTestCase {
    private func manifest(for body: String, path: String = "/downloads/missiongo-macos-latest.zip") throws -> AppUpdater.Manifest {
        let data = Data(body.utf8)
        return try AppUpdater.decode(manifest: Data(manifestJSON(
            sha256: AppUpdater.digest(of: data), size: data.count, downloadPath: path
        ).utf8))
    }

    func testAcceptsAZipWhoseDigestMatches() async throws {
        let body = "pretend this is a zip"
        let manifest = try manifest(for: body)
        StubURLProtocol.install { _, _ in .response(status: 200, body: body) }

        let data = try await AppUpdater.download(
            manifest, serverUrl: "https://s.invalid", session: StubURLProtocol.session()
        )
        XCTAssertEqual(String(decoding: data, as: UTF8.self), body)
        XCTAssertEqual(
            StubURLProtocol.recorded.last?.request.url?.absoluteString,
            "https://s.invalid/downloads/missiongo-macos-latest.zip"
        )
    }

    /// A truncated download is the case this catches: the bytes arrive, the
    /// digest does not match, and unpacking them would report "damaged" instead.
    func testRefusesAZipWhoseDigestDoesNot() async throws {
        let manifest = try manifest(for: "the published build")
        StubURLProtocol.install { _, _ in .response(status: 200, body: "the published bui") }
        do {
            _ = try await AppUpdater.download(
                manifest, serverUrl: "https://s.invalid", session: StubURLProtocol.session()
            )
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? AppUpdater.UpdateError, .digestMismatch)
        }
    }
}

final class AppUpdaterInstallTests: XCTestCase {
    /// A bundle with nothing in it but the Info.plist the checks read.
    private func makeBundle(in directory: URL, version: String, identifier: String) throws -> URL {
        let bundle = directory.appendingPathComponent("MissionGo.app")
        let contents = bundle.appendingPathComponent("Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let info: [String: Any] = [
            "CFBundleShortVersionString": version,
            "CFBundleIdentifier": identifier,
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try data.write(to: contents.appendingPathComponent("Info.plist"))
        return bundle
    }

    private func manifest(version: String) throws -> AppUpdater.Manifest {
        return try AppUpdater.decode(manifest: Data(manifestJSON(version: version).utf8))
    }

    func testAcceptsTheBuildTheManifestPromised() throws {
        let root = try temporaryDirectory()
        let bundle = try makeBundle(in: root, version: "0.4.0", identifier: "io.missiongo.macos")
        XCTAssertNoThrow(try AppUpdater.validate(
            bundle: bundle, manifest: try manifest(version: "0.4.0"), expectedIdentifier: "io.missiongo.macos"
        ))
    }

    /// The zip is served under a fixed name, so a stale one behind a cache is a
    /// real possibility -- and by then the digest has already passed.
    func testRefusesABundleThatIsNotTheVersionAdvertised() throws {
        let root = try temporaryDirectory()
        let bundle = try makeBundle(in: root, version: "0.3.1", identifier: "io.missiongo.macos")
        XCTAssertThrowsError(try AppUpdater.validate(
            bundle: bundle, manifest: try manifest(version: "0.4.0"), expectedIdentifier: "io.missiongo.macos"
        ))
    }

    func testRefusesSomeOtherApp() throws {
        let root = try temporaryDirectory()
        let bundle = try makeBundle(in: root, version: "0.4.0", identifier: "com.example.other")
        XCTAssertThrowsError(try AppUpdater.validate(
            bundle: bundle, manifest: try manifest(version: "0.4.0"), expectedIdentifier: "io.missiongo.macos"
        ))
    }

    /// Running from `swift run` there is no identifier to compare against.
    func testSkipsTheIdentityCheckWhenThereIsNoIdentifier() throws {
        let root = try temporaryDirectory()
        let bundle = try makeBundle(in: root, version: "0.4.0", identifier: "com.example.other")
        XCTAssertNoThrow(try AppUpdater.validate(
            bundle: bundle, manifest: try manifest(version: "0.4.0"), expectedIdentifier: nil
        ))
    }

    func testRefusesAnArchiveWithoutExactlyOneApp() throws {
        let root = try temporaryDirectory()
        XCTAssertThrowsError(try AppUpdater.locateBundle(in: root))
        _ = try makeBundle(in: root, version: "0.4.0", identifier: "io.missiongo.macos")
        XCTAssertEqual(try AppUpdater.locateBundle(in: root).lastPathComponent, "MissionGo.app")
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("Other.app"), withIntermediateDirectories: true
        )
        XCTAssertThrowsError(try AppUpdater.locateBundle(in: root))
    }

    /// The whole flow against a real ditto archive, with codesign and xattr
    /// stubbed: those need a signed bundle, which a unit test cannot make.
    func testUnpacksAndReplacesTheRunningBundle() async throws {
        let root = try temporaryDirectory()
        let source = try makeBundle(in: root.appendingPathComponent("src", isDirectory: true), version: "0.4.0", identifier: "io.missiongo.macos")
        let archive = root.appendingPathComponent("MissionGo-macOS.zip")
        let packed = await AppUpdater.systemRunner("/usr/bin/ditto", ["-c", "-k", "--keepParent", source.path, archive.path])
        XCTAssertEqual(packed.code, 0, packed.output)

        let installed = try makeBundle(in: root.appendingPathComponent("Applications", isDirectory: true), version: "0.3.1", identifier: "io.missiongo.macos")
        let zip = try Data(contentsOf: archive)

        let calls = Locked<[String]>([])
        let result = try await AppUpdater.install(
            zip: zip,
            manifest: try manifest(version: "0.4.0"),
            replacing: installed,
            expectedIdentifier: "io.missiongo.macos",
            run: { path, args in
                if path == "/usr/bin/ditto" { return await AppUpdater.systemRunner(path, args) }
                calls.withLock { $0.append(path) }
                return (0, "")
            }
        )

        XCTAssertEqual(result, installed)
        XCTAssertEqual(calls.current, ["/usr/bin/codesign", "/usr/bin/xattr"])
        let info = try PropertyListSerialization.propertyList(
            from: try Data(contentsOf: installed.appendingPathComponent("Contents/Info.plist")), format: nil
        ) as? [String: Any]
        XCTAssertEqual(info?["CFBundleShortVersionString"] as? String, "0.4.0")
    }

    func testStopsBeforeReplacingWhenSignatureVerificationFails() async throws {
        let root = try temporaryDirectory()
        let source = try makeBundle(in: root.appendingPathComponent("src", isDirectory: true), version: "0.4.0", identifier: "io.missiongo.macos")
        let archive = root.appendingPathComponent("MissionGo-macOS.zip")
        _ = await AppUpdater.systemRunner("/usr/bin/ditto", ["-c", "-k", "--keepParent", source.path, archive.path])
        let installed = try makeBundle(in: root.appendingPathComponent("Applications", isDirectory: true), version: "0.3.1", identifier: "io.missiongo.macos")

        do {
            _ = try await AppUpdater.install(
                zip: try Data(contentsOf: archive),
                manifest: try manifest(version: "0.4.0"),
                replacing: installed,
                expectedIdentifier: "io.missiongo.macos",
                run: { path, args in
                    if path == "/usr/bin/ditto" { return await AppUpdater.systemRunner(path, args) }
                    return path == "/usr/bin/codesign" ? (1, "code object is not signed at all") : (0, "")
                }
            )
            XCTFail("expected a failure")
        } catch {
            guard case .badBundle = error as? AppUpdater.UpdateError ?? .digestMismatch else {
                return XCTFail("expected badBundle, got \(error)")
            }
        }
        // The install on disk is untouched: a rejected download must never cost
        // the person the version they already had.
        let info = try PropertyListSerialization.propertyList(
            from: try Data(contentsOf: installed.appendingPathComponent("Contents/Info.plist")), format: nil
        ) as? [String: Any]
        XCTAssertEqual(info?["CFBundleShortVersionString"] as? String, "0.3.1")
    }

    func testRelaunchWaitsForThisProcessToGoAway() {
        let command = AppUpdater.relaunchCommand(bundle: URL(fileURLWithPath: "/Applications/MissionGo.app"), pid: 4321)
        XCTAssertEqual(command.file, "/bin/sh")
        XCTAssertEqual(command.args.first, "-c")
        XCTAssertTrue(command.args[1].contains("kill -0 4321"))
        // The path is an argument, never spliced into the script: a bundle path
        // with a space or a quote in it must not become shell syntax.
        XCTAssertEqual(command.args.last, "/Applications/MissionGo.app")
        XCTAssertFalse(command.args[1].contains("/Applications/MissionGo.app"))
    }
}
