import Foundation

/// Helpers that keep the Swift port reading files the way the TypeScript did.
///
/// Foundation's defaults differ from JavaScript in quiet ways that matter here:
/// `JSONSerialization` hands back `NSNumber` for both `true` and `1`, and
/// `NSString.standardizingPath` resolves symlinks, which Node's `path.resolve`
/// never does. Each helper exists to close one of those gaps.
enum JSONValues {
    /// Parses a JSON document, returning nil for anything unparseable — the
    /// callers treat a broken `~/.claude.json` the same as a missing one.
    static func parse(_ raw: String) -> Any? {
        guard let data = raw.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    /// `value === true` in JavaScript: only a JSON boolean counts, never `1`.
    static func isTrue(_ value: Any?) -> Bool {
        return bool(value) == true
    }

    /// `typeof value === "boolean"`.
    static func bool(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    /// `typeof value === "number"`: a JSON number, and not a boolean bridged
    /// into NSNumber.
    static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return number.doubleValue
    }

    /// `JSON.stringify(string)`, used to quote a rejected value in an error so
    /// whitespace and newlines stay visible.
    static func quote(_ string: String) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard let data = try? encoder.encode(string), let text = String(data: data, encoding: .utf8) else {
            return "\"\(string)\""
        }
        return text
    }
}

public enum Paths {
    /// Node's `path.resolve` for POSIX paths: absolute against the current
    /// directory, `.` and `..` collapsed, trailing slash dropped, and symlinks
    /// left alone. The trust table is keyed by the path the operator opened, so
    /// resolving `/tmp` into `/private/tmp` would stop it matching.
    public static func resolve(_ path: String, cwd: String = FileManager.default.currentDirectoryPath) -> String {
        let joined = path.hasPrefix("/") ? path : "\(cwd)/\(path)"
        var parts: [Substring] = []
        for part in joined.split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." {
                if !parts.isEmpty { parts.removeLast() }
                continue
            }
            parts.append(part)
        }
        return "/" + parts.joined(separator: "/")
    }

    public static func isAbsolute(_ path: String) -> Bool {
        return path.hasPrefix("/")
    }

    public static func basename(_ path: String) -> String {
        return path.split(separator: "/").last.map(String.init) ?? ""
    }

    public static func join(_ base: String, _ component: String) -> String {
        return base.hasSuffix("/") ? base + component : "\(base)/\(component)"
    }

    /// `statSync(path)` succeeding: the entry exists, as a file or a directory.
    public static func exists(_ path: String) -> Bool {
        return FileManager.default.fileExists(atPath: path)
    }

    public static func isDirectory(_ path: String) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    public static func homeDirectory() -> String {
        return FileManager.default.homeDirectoryForCurrentUser.path
    }
}

/// A regular expression anchored with `\A` and `\z`.
///
/// ICU's `$` also matches in front of a trailing newline, so the JavaScript
/// pattern `^AND-\d+$` copied verbatim would accept `"AND-37\n"` — exactly the
/// kind of value the validation exists to refuse before it reaches argv.
struct AnchoredPattern {
    private let regex: NSRegularExpression

    init(_ body: String) {
        // The patterns are compile-time literals; a typo is a programming error.
        regex = try! NSRegularExpression(pattern: "\\A(?:\(body))\\z")
    }

    func matches(_ value: String) -> Bool {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return regex.firstMatch(in: value, options: [], range: range) != nil
    }
}

/// A lock around a value, for the small amount of state shared between the
/// loops, URLSession callbacks and Network.framework queues.
final class Locked<Value>: @unchecked Sendable {
    private var value: Value
    private let lock = NSLock()

    init(_ value: Value) {
        self.value = value
    }

    func withLock<Result>(_ body: (inout Value) throws -> Result) rethrows -> Result {
        lock.lock()
        defer { lock.unlock() }
        return try body(&value)
    }

    var current: Value {
        return withLock { $0 }
    }
}
