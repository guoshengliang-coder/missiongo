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
    "releaseNotes":[{"pullRequestNumber":94,"title":"Improve batch UX",\
    "items":[{"key":"AND-122","title":"批量操作体验"}]}],\
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
        XCTAssertEqual(manifest.buildTimestamp, "20260915033846")
        XCTAssertEqual(manifest.releaseNotes?.first?.pullRequestNumber, 94)
        XCTAssertEqual(manifest.releaseNotes?.first?.items.first?.key, "AND-122")
        XCTAssertTrue(manifest.releaseNotesText.contains("PR #94"))
        XCTAssertTrue(manifest.releaseNotesText.contains("AND-122 · 批量操作体验"))
        // The PR title is a git subject, often English; only declared Chinese
        // titles may reach the alert.
        XCTAssertFalse(manifest.releaseNotesText.contains("Improve batch UX"))
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

    /// The whole flow against a real ditto archive, with codesign and spctl
    /// stubbed: those need a signed bundle, which a unit test cannot make.
    func testUnpacksAndReplacesTheRunningBundle() async throws {
        try await exerciseUpdate()
    }

    func testExplicitAdHocDistributionCanUpdateToAVerifiedAdHocBundle() async throws {
        try await exerciseUpdate(allowAdHoc: true, signature: "Signature=adhoc\nTeamIdentifier=not set\n")
    }

    func testAdHocDistributionStillAssessesNonAdHocSignatures() async throws {
        try await exerciseUpdate(allowAdHoc: true, signature: "Authority=Developer ID Application: Test\n")
    }

    private func exerciseUpdate(allowAdHoc: Bool = false, signature: String = "") async throws {
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
            allowAdHocUpdates: allowAdHoc,
            run: { path, args in
                if path == "/usr/bin/ditto" { return await AppUpdater.systemRunner(path, args) }
                calls.withLock { $0.append(path) }
                if args.first == "-d" { return (0, signature) }
                return (0, "")
            }
        )

        XCTAssertEqual(result, installed)
        var expected = ["/usr/bin/codesign"]
        if allowAdHoc { expected.append("/usr/bin/codesign") }
        if !allowAdHoc || !signature.contains("Signature=adhoc\n") { expected.append("/usr/sbin/spctl") }
        XCTAssertEqual(calls.current, expected)
        let info = try PropertyListSerialization.propertyList(
            from: try Data(contentsOf: installed.appendingPathComponent("Contents/Info.plist")), format: nil
        ) as? [String: Any]
        XCTAssertEqual(info?["CFBundleShortVersionString"] as? String, "0.4.0")
    }

    func testStopsBeforeReplacingWhenSignatureVerificationFails() async throws {
        try await assertRejectedUpdate(failingTool: "/usr/bin/codesign")
    }

    func testStopsBeforeReplacingWhenGatekeeperRejectsTheUpdate() async throws {
        try await assertRejectedUpdate(failingTool: "/usr/sbin/spctl")
    }

    func testAdHocExceptionNeverSkipsIntegrityVerification() async throws {
        try await assertRejectedUpdate(failingTool: "/usr/bin/codesign", allowAdHoc: true)
    }

    private func assertRejectedUpdate(failingTool: String, allowAdHoc: Bool = false) async throws {
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
                allowAdHocUpdates: allowAdHoc,
                run: { path, args in
                    if path == "/usr/bin/ditto" { return await AppUpdater.systemRunner(path, args) }
                    return path == failingTool ? (1, "verification rejected") : (0, "")
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

    // MARK: Translocated copies

    /// The read-only projection macOS makes of a quarantined app it was started
    /// from outside an approved location -- the path in the console's update
    /// failure, "You don't have permission to save the file".
    private var translocatedBundle: URL {
        return URL(fileURLWithPath: "/private/var/folders/9f/lw4n5vk520j0d28cv3q6f3hm0000gn/T/AppTranslocation/"
            + "21B35289-FDD9-4BF7-8A73-7156B7E21262/d/MissionGo.app")
    }

    private func packedBundle(in root: URL, version: String = "0.4.0") async throws -> Data {
        let source = try makeBundle(
            in: root.appendingPathComponent("src", isDirectory: true),
            version: version,
            identifier: "io.missiongo.macos"
        )
        let archive = root.appendingPathComponent("MissionGo-macOS.zip")
        let packed = await AppUpdater.systemRunner("/usr/bin/ditto", ["-c", "-k", "--keepParent", source.path, archive.path])
        XCTAssertEqual(packed.code, 0, packed.output)
        return try Data(contentsOf: archive)
    }

    /// ditto is real (the bundle has to survive extraction); the signing tools
    /// are stubbed because a unit test cannot produce a signed bundle.
    private func stubbedRun(signature: String = "") -> AppUpdater.ToolRunner {
        return { path, args in
            if path == "/usr/bin/ditto" { return await AppUpdater.systemRunner(path, args) }
            if args.first == "-d" { return (0, signature) }
            return (0, "")
        }
    }

    private func versionOfBundle(at bundle: URL) throws -> String? {
        let info = try PropertyListSerialization.propertyList(
            from: try Data(contentsOf: bundle.appendingPathComponent("Contents/Info.plist")), format: nil
        ) as? [String: Any]
        return info?["CFBundleShortVersionString"] as? String
    }

    func testRecognisesATranslocatedProjectionAndNothingElse() {
        XCTAssertTrue(AppUpdater.isTranslocated(bundle: translocatedBundle))
        XCTAssertFalse(AppUpdater.isTranslocated(bundle: URL(fileURLWithPath: "/Applications/MissionGo.app")))
        XCTAssertFalse(AppUpdater.isTranslocated(bundle: URL(fileURLWithPath: "/Users/someone/Applications/MissionGo.app")))
    }

    /// A translocated copy cannot replace itself, so the verified build goes to
    /// an approved location -- and that is the bundle handed back to relaunch.
    func testInstallsATranslocatedCopyIntoAnApprovedLocation() async throws {
        let root = try temporaryDirectory()
        let zip = try await packedBundle(in: root)
        let applications = root.appendingPathComponent("Applications", isDirectory: true)

        let installed = try await AppUpdater.install(
            zip: zip,
            manifest: try manifest(version: "0.4.0"),
            replacing: translocatedBundle,
            expectedIdentifier: "io.missiongo.macos",
            allowAdHocUpdates: true,
            installRoots: [applications],
            run: stubbedRun(signature: "Signature=adhoc\n")
        )

        XCTAssertEqual(installed, applications.appendingPathComponent("MissionGo.app"))
        XCTAssertEqual(try versionOfBundle(at: installed), "0.4.0")
        // Nothing was written into the projection, and no staging copy was left
        // behind for someone to launch by mistake.
        XCTAssertFalse(FileManager.default.fileExists(atPath: translocatedBundle.path))
        let entries = try FileManager.default.contentsOfDirectory(atPath: applications.path)
        XCTAssertEqual(entries, ["MissionGo.app"])
    }

    /// /Applications is where a normal install lives, but it is not always
    /// writable; ~/Applications is an approved location too, so use it.
    func testFallsBackToTheSecondApprovedLocation() async throws {
        let root = try temporaryDirectory()
        let zip = try await packedBundle(in: root)
        let unwritable = root.appendingPathComponent("not-a-directory", isDirectory: false)
        try Data("x".utf8).write(to: unwritable)
        let homeApplications = root.appendingPathComponent("home/Applications", isDirectory: true)

        let installed = try await AppUpdater.install(
            zip: zip,
            manifest: try manifest(version: "0.4.0"),
            replacing: translocatedBundle,
            expectedIdentifier: "io.missiongo.macos",
            allowAdHocUpdates: true,
            installRoots: [unwritable, homeApplications],
            run: stubbedRun(signature: "Signature=adhoc\n")
        )

        XCTAssertEqual(installed, homeApplications.appendingPathComponent("MissionGo.app"))
        XCTAssertEqual(try versionOfBundle(at: installed), "0.4.0")
    }

    /// When no location takes the copy, say what the person can do instead of
    /// leaving the system's "folder d" wording as the only explanation.
    func testExplainsWhenNoApprovedLocationAcceptsTheCopy() async throws {
        let root = try temporaryDirectory()
        let zip = try await packedBundle(in: root)
        let unwritable = root.appendingPathComponent("not-a-directory", isDirectory: false)
        try Data("x".utf8).write(to: unwritable)

        do {
            _ = try await AppUpdater.install(
                zip: zip,
                manifest: try manifest(version: "0.4.0"),
                replacing: translocatedBundle,
                expectedIdentifier: "io.missiongo.macos",
                allowAdHocUpdates: true,
                installRoots: [unwritable],
                run: stubbedRun(signature: "Signature=adhoc\n")
            )
            XCTFail("expected a failure")
        } catch {
            guard case let .install(detail) = error as? AppUpdater.UpdateError ?? .digestMismatch else {
                return XCTFail("expected install, got \(error)")
            }
            XCTAssertTrue(detail.contains("App Translocation"))
            XCTAssertTrue(detail.contains("应用程序"))
        }
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
