import CryptoKit
import Foundation

/// Keeps this Mac's MissionGo client current with the deployment it is signed
/// in to.
///
/// The Skill already updates itself (see `SkillSync`); the app around it did
/// not. A machine that takes dispatches would sit on whatever build someone
/// installed months ago, running an older client against a server that has
/// moved on -- and nothing in the console says so.
///
/// The shape follows `SkillSync` on purpose: read a fixed address on the
/// server, compare versions numerically, act only when the remote one is newer,
/// and treat every failure as something to show rather than something fatal.
/// A Mac that cannot check for updates must still take work.
public enum AppUpdater {
    /// Written by scripts/publish-macos.sh, served by deploy/nginx-container.conf.
    /// Deliberately not the `.release` file beside it: that one carries
    /// source_commit and source_dirty and is kept out of the web image.
    public static let manifestPath = "/downloads/missiongo-macos-latest.json"

    static let manifestTimeout: TimeInterval = 20
    static let downloadTimeout: TimeInterval = 600
    static let maxManifestBytes = 64_000
    /// A ceiling, not a size check -- the manifest's `size` is the real one.
    /// This only stops an unbounded body from filling memory.
    static let maxZipBytes = 500_000_000

    /// What the server says the current build is.
    public struct Manifest: Equatable, Sendable, Decodable {
        public let version: String
        public let sha256: String
        public let size: Int
        public let downloadPath: String
        public let minimumSystemVersion: String?
    }

    public struct Available: Equatable, Sendable {
        public let current: String
        public let manifest: Manifest

        public var version: String { return manifest.version }
    }

    public enum UpdateError: Error, Equatable, LocalizedError {
        case download(String)
        case badManifest(String)
        case digestMismatch
        case unpack(String)
        case badBundle(String)
        case install(String)

        public var errorDescription: String? {
            switch self {
            case let .download(detail): return "下载更新失败：\(detail)"
            case let .badManifest(detail): return "服务器返回的更新信息无法读取：\(detail)"
            case .digestMismatch: return "下载的安装包校验不通过，可能没下完或已损坏。"
            case let .unpack(detail): return "解压更新失败：\(detail)"
            case let .badBundle(detail): return "下载到的不是有效的 MissionGo：\(detail)"
            case let .install(detail): return "安装更新失败：\(detail)"
            }
        }
    }

    /// Runs one system tool. Injected so the tests can drive install without
    /// codesign or a real bundle.
    public typealias ToolRunner = @Sendable (_ path: String, _ args: [String]) async -> (code: Int32, output: String)

    // MARK: Current version

    /// This build's version, or nil when it cannot be read.
    ///
    /// Nil is the normal answer for `swift run`, which has no Info.plist, and
    /// for anything whose version is not a dotted number. Both mean the same
    /// thing here: there is nothing to compare against, so do not check.
    public static func currentVersion(bundle: Bundle = .main) -> String? {
        guard let raw = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
              Version.numericParts(raw) != nil
        else { return nil }
        return raw
    }

    // MARK: Check

    /// The published build when it is newer than `currentVersion`, else nil.
    public static func check(
        serverUrl: String,
        currentVersion: String,
        session: URLSession = .shared
    ) async throws -> Available? {
        let manifest = try await fetchManifest(serverUrl: serverUrl, session: session)
        guard Version.isNewer(manifest.version, than: currentVersion) else { return nil }
        return Available(current: currentVersion, manifest: manifest)
    }

    static func fetchManifest(serverUrl: String, session: URLSession) async throws -> Manifest {
        guard let url = URL(string: serverUrl + manifestPath) else { throw UpdateError.download("地址无效") }
        var request = URLRequest(url: url, timeoutInterval: manifestTimeout)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await send(request, session: session)
        guard data.count <= maxManifestBytes else { throw UpdateError.badManifest("内容过大") }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw UpdateError.download("HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        return try decode(manifest: data)
    }

    /// Kept separate from the request so a body that is not the manifest -- the
    /// console's index.html, most often -- fails as bad content rather than as a
    /// decoding crash.
    static func decode(manifest data: Data) throws -> Manifest {
        let manifest: Manifest
        do {
            manifest = try JSONDecoder().decode(Manifest.self, from: data)
        } catch {
            throw UpdateError.badManifest("不是预期的 JSON")
        }
        guard Version.numericParts(manifest.version) != nil else {
            throw UpdateError.badManifest("版本号 \(manifest.version) 不是数字")
        }
        guard isHexDigest(manifest.sha256) else { throw UpdateError.badManifest("校验和格式不对") }
        guard manifest.size > 0, manifest.size <= maxZipBytes else { throw UpdateError.badManifest("大小不合理") }
        // A path, never a host: the update must come from the server this Mac is
        // signed in to, not from wherever a manifest points.
        guard manifest.downloadPath.hasPrefix("/"), !manifest.downloadPath.hasPrefix("//") else {
            throw UpdateError.badManifest("下载路径必须是本服务器上的绝对路径")
        }
        return manifest
    }

    static func isHexDigest(_ value: String) -> Bool {
        return value.count == 64 && value.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }

    // MARK: Download

    /// The zip named by the manifest, once its digest matches.
    ///
    /// The digest is what catches a truncated or corrupted download. It is not a
    /// second line of defence against a compromised server: the manifest and the
    /// zip come from the same origin over the same TLS connection, so whoever
    /// could change one could change the other.
    public static func download(
        _ manifest: Manifest,
        serverUrl: String,
        session: URLSession = .shared
    ) async throws -> Data {
        guard let url = URL(string: serverUrl + manifest.downloadPath) else {
            throw UpdateError.download("地址无效")
        }
        var request = URLRequest(url: url, timeoutInterval: downloadTimeout)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await send(request, session: session)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw UpdateError.download("HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        guard data.count <= maxZipBytes else { throw UpdateError.download("安装包过大") }
        guard digest(of: data) == manifest.sha256 else { throw UpdateError.digestMismatch }
        return data
    }

    static func send(_ request: URLRequest, session: URLSession) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch {
            throw UpdateError.download(error.localizedDescription)
        }
    }

    static func digest(of data: Data) -> String {
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: Install

    /// Unpacks `zip`, checks that what came out is a newer build of this same
    /// app, and puts it where the running one is.
    ///
    /// Returns the bundle to relaunch. The caller quits afterwards; see
    /// `relaunchCommand`.
    public static func install(
        zip: Data,
        manifest: Manifest,
        replacing bundle: URL,
        expectedIdentifier: String?,
        run: ToolRunner = systemRunner
    ) async throws -> URL {
        let work = try workDirectory()
        defer { try? FileManager.default.removeItem(at: work) }

        let archive = work.appendingPathComponent("MissionGo-macOS.zip")
        do {
            try zip.write(to: archive, options: .atomic)
        } catch {
            throw UpdateError.install(error.localizedDescription)
        }

        let unpacked = work.appendingPathComponent("unpacked", isDirectory: true)
        // ditto, matching the ditto -c -k that made the archive: a plain unzip
        // drops the symlinks and extended attributes inside the bundle, and the
        // result is reported to the person as "the app is damaged".
        let extraction = await run("/usr/bin/ditto", ["-x", "-k", archive.path, unpacked.path])
        guard extraction.code == 0 else { throw UpdateError.unpack(extraction.output) }

        let newBundle = try locateBundle(in: unpacked)
        try validate(bundle: newBundle, manifest: manifest, expectedIdentifier: expectedIdentifier)

        let verification = await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", newBundle.path])
        guard verification.code == 0 else { throw UpdateError.badBundle("签名校验失败：\(verification.output)") }

        // The app is signed ad hoc, not notarized, so a quarantine attribute on
        // it is the difference between launching and "cannot be opened". A file
        // written by URLSession should not carry one -- that attribute is set by
        // whoever downloads, and this app does not ask for it -- but the cost of
        // being wrong is replacing a working install with one that will not
        // start, so strip it rather than reason about it. Nothing to remove is
        // not a failure.
        _ = await run("/usr/bin/xattr", ["-d", "-r", "com.apple.quarantine", newBundle.path])

        do {
            _ = try FileManager.default.replaceItemAt(bundle, withItemAt: newBundle)
        } catch {
            throw UpdateError.install(
                "无法替换 \(bundle.path)：\(error.localizedDescription)。"
                + "把新版本手工拖进「应用程序」也可以完成更新。"
            )
        }
        return bundle
    }

    static func workDirectory() throws -> URL {
        // Under Caches rather than /tmp: same volume as /Applications, so
        // replaceItemAt is a rename and not a copy across devices.
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let directory = caches
            .appendingPathComponent("io.missiongo.macos", isDirectory: true)
            .appendingPathComponent("updates", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            throw UpdateError.install(error.localizedDescription)
        }
        return directory
    }

    /// The one `.app` the archive should contain.
    static func locateBundle(in directory: URL) throws -> URL {
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]
        )) ?? []
        let apps = entries.filter { $0.pathExtension == "app" }
        guard let app = apps.first, apps.count == 1 else {
            throw UpdateError.badBundle(apps.isEmpty ? "压缩包里没有 .app" : "压缩包里有多个 .app")
        }
        return app
    }

    /// Refuses anything that is not the build the manifest promised, or not this
    /// same app. Without this an update is "replace myself with whatever the
    /// server sent", and a mismatched or wrong bundle would only be discovered
    /// after the running app had already been overwritten.
    static func validate(bundle: URL, manifest: Manifest, expectedIdentifier: String?) throws {
        let plist = bundle.appendingPathComponent("Contents/Info.plist")
        guard let data = FileManager.default.contents(atPath: plist.path),
              let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { throw UpdateError.badBundle("读不到 Info.plist") }

        guard let version = info["CFBundleShortVersionString"] as? String else {
            throw UpdateError.badBundle("Info.plist 里没有版本号")
        }
        guard version == manifest.version else {
            throw UpdateError.badBundle("下载到的是 \(version)，服务器说的是 \(manifest.version)")
        }
        // Compared against the running app rather than a literal: the bundle
        // identifier is declared in product.json, and repeating it here would be
        // a second declaration to keep in sync.
        if let expectedIdentifier {
            guard let identifier = info["CFBundleIdentifier"] as? String, identifier == expectedIdentifier else {
                throw UpdateError.badBundle("这不是 \(expectedIdentifier)")
            }
        }
    }

    // MARK: Relaunch

    /// Waits for this process to go away, then opens the new bundle.
    ///
    /// Run detached before terminating: a child started here outlives the app,
    /// the same way a dispatched session does, so nothing has to stay alive to
    /// bring the new version up.
    public static func relaunchCommand(bundle: URL, pid: Int32) -> (file: String, args: [String]) {
        let script = "while /bin/kill -0 \(pid) 2>/dev/null; do /bin/sleep 0.2; done; /usr/bin/open -n \"$1\""
        return ("/bin/sh", ["-c", script, "--", bundle.path])
    }

    public static let systemRunner: ToolRunner = { path, args in
        return await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: path)
                process.arguments = args
                process.standardInput = FileHandle.nullDevice
                let pipe = Pipe()
                process.standardOutput = pipe
                process.standardError = pipe
                do {
                    try process.run()
                } catch {
                    continuation.resume(returning: (-1, error.localizedDescription))
                    return
                }
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                let output = String(decoding: data, as: UTF8.self)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                continuation.resume(returning: (process.terminationStatus, output))
            }
        }
    }
}
