import Darwin
import Foundation

public struct AgentArtifactJob: Codable, Sendable {
    public let id: String
    public let sessionId: String
    public let sessionRef: String
    public let agentKind: String
    public let sourceId: String
    public let href: String
}
public struct AgentArtifactFile: Codable, Sendable {
    public let name: String
    public let contentType: String
    public let base64: String
}
public struct AgentArtifactBundle: Codable, Sendable {
    public let entry: String
    public let files: [AgentArtifactFile]
}
public struct AgentArtifactResult: Codable, Sendable {
    public var bundle: AgentArtifactBundle?
    public var error: String?
    public init(bundle: AgentArtifactBundle? = nil, error: String? = nil) { self.bundle = bundle; self.error = error }
}
public enum AgentArtifactError: String, Error {
    case fileMissing = "file_missing", unsupported, referenceMissing = "reference_missing", fileDenied = "file_denied"
    case tooLarge = "too_large", resourceMissing = "resource_missing", nodeUnavailable = "node_unavailable"
}

/// Only explicit output links in this exact native transcript are eligible. No directory scan, command or URL fetch.
public enum AgentArtifactReader {
    static let types = [
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml",
        "html": "text/html", "htm": "text/html", "md": "text/markdown", "txt": "text/plain", "log": "text/plain", "csv": "text/csv",
        "json": "application/json", "pdf": "application/pdf", "css": "text/css", "js": "text/javascript", "mjs": "text/javascript",
        "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf"
    ]
    static let linkPattern = #"!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)"#

    static func captures(_ pattern: String, in text: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return [] }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
            for index in 1..<match.numberOfRanges {
                if let range = Range(match.range(at: index), in: text) { return String(text[range]) }
            }
            return nil
        }
    }

    static func path(_ href: String) -> String? {
        var value = href.replacingOccurrences(of: #"^(?:sandbox:|file://(?:localhost)?)"#, with: "", options: .regularExpression)
        value = String(value.prefix { $0 != "?" && $0 != "#" })
        guard let decoded = value.removingPercentEncoding,
              decoded.range(of: #"^/(?:Users|private|tmp|var/folders|Volumes|home|mnt)/"#, options: .regularExpression) != nil,
              !decoded.contains("\\"), !decoded.unicodeScalars.contains(where: { $0.value < 32 }),
              !decoded.split(separator: "/").contains("..") else { return nil }
        return decoded
    }

    public static func read(job: AgentArtifactJob, messages: [AgentSessionMessage]) throws -> AgentArtifactBundle {
        guard let message = messages.first(where: { $0.sourceId == job.sourceId && ["agent", "plan"].contains($0.role) }),
              captures(linkPattern, in: message.text).contains(job.href), let path = path(job.href) else { throw AgentArtifactError.referenceMissing }
        let entryURL = URL(fileURLWithPath: path).standardizedFileURL
        let root = entryURL.deletingLastPathComponent().resolvingSymlinksInPath()
        let entry = entryURL.lastPathComponent
        guard !["css", "js", "mjs", "woff", "woff2", "ttf"].contains(entryURL.pathExtension.lowercased()),
              types[entryURL.pathExtension.lowercased()] != nil else { throw AgentArtifactError.unsupported }
        let directory = open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard directory >= 0 else { throw AgentArtifactError.fileMissing }
        defer { close(directory) }
        var pending = [entry]
        var seen: Set<String> = []
        var files: [AgentArtifactFile] = []
        var total = 0
        while !pending.isEmpty {
            let name = pending.removeFirst()
            if seen.contains(name) { continue }
            guard seen.count < 64 else { throw AgentArtifactError.tooLarge }
            seen.insert(name)
            guard let contentType = types[(name as NSString).pathExtension.lowercased()] else { throw AgentArtifactError.unsupported }
            let bytes: Data
            do { bytes = try readFile(directory: directory, name: name) }
            catch AgentArtifactError.fileMissing where name != entry { throw AgentArtifactError.resourceMissing }
            total += bytes.count
            guard total <= 32 * 1024 * 1024 else { throw AgentArtifactError.tooLarge }
            files.append(AgentArtifactFile(name: name, contentType: contentType, base64: bytes.base64EncodedString()))
            if ["text/html", "text/css", "text/javascript", "text/markdown"].contains(contentType), let text = String(data: bytes, encoding: .utf8) {
                for reference in references(text, type: contentType) {
                    if let resource = try relativeResource(reference, from: name) { pending.append(resource) }
                }
            }
        }
        return AgentArtifactBundle(entry: entry, files: files)
    }

    static func references(_ text: String, type: String) -> [String] {
        if type == "text/css" { return cssReferences(text) }
        if type == "text/javascript" { return moduleReferences(text) }
        if type == "text/markdown" { return captures(linkPattern, in: text) }
        guard type == "text/html" else { return [] }

        let html = text.replacingOccurrences(of: #"(?s)<!--.*?-->"#, with: "", options: .regularExpression)
        let scripts = captures(#"(?s)<script\b(?:[^>"']|"[^"]*"|'[^']*')*>(.*?)</script\s*>"#, in: html)
        let styles = captures(#"(?s)<style\b(?:[^>"']|"[^"]*"|'[^']*')*>(.*?)</style\s*>"#, in: html)
        // Attribute-looking strings and URL API calls inside scripts are not HTML/CSS dependencies.
        var markup = html
        for element in ["script", "style"] {
            let pattern = "(?is)(<" + element + #"\b(?:[^>"']|"[^"]*"|'[^']*')*>).*?(</"# + element + #"\s*>)"#
            markup = markup.replacingOccurrences(of: pattern, with: "$1$2", options: .regularExpression)
        }
        var result = styles.flatMap(cssReferences) + scripts.flatMap(moduleReferences)
        for tag in captures(#"(<(?:[^<>"']|"[^"]*"|'[^']*')+>)"#, in: markup) {
            result += captures(#"\s(?:src|href|poster)\s*=\s*["']([^"']+)["']"#, in: tag)
            for style in captures(#"\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')"#, in: tag) { result += cssReferences(style) }
        }
        return result
    }

    static func cssReferences(_ text: String) -> [String] {
        let css = text.replacingOccurrences(of: #"(?s)/\*.*?\*/"#, with: "", options: .regularExpression)
        return captures(#"\burl\(\s*["']?([^\s)'";]+)"#, in: css)
            + captures(#"@import\s+["']([^"']+)["']"#, in: css)
    }

    static func moduleReferences(_ text: String) -> [String] {
        captures(#"(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']+)["']"#, in: text)
    }

    static func relativeResource(_ reference: String, from: String) throws -> String? {
        if reference.hasPrefix("#") || reference.hasPrefix("//") || reference.range(of: #"^[a-z][a-z0-9+.-]*:"#, options: [.regularExpression, .caseInsensitive]) != nil { return nil }
        guard !reference.hasPrefix("/"), !reference.contains("\\"),
              let decoded = String(reference.prefix { $0 != "?" && $0 != "#" }).removingPercentEncoding else { throw AgentArtifactError.fileDenied }
        let base = URL(fileURLWithPath: "/bundle/" + from).deletingLastPathComponent()
        let url = base.appendingPathComponent(decoded).standardizedFileURL
        guard url.path.hasPrefix("/bundle/") else { throw AgentArtifactError.fileDenied }
        let relative = String(url.path.dropFirst("/bundle/".count))
        guard !relative.split(separator: "/").contains(where: { $0.hasPrefix(".") }) else { throw AgentArtifactError.fileDenied }
        return relative
    }

    /// Walk beneath the already opened directory. Reject symlinks, devices, FIFOs and oversized files before reading.
    static func readFile(directory: Int32, name: String) throws -> Data {
        let parts = name.split(separator: "/").map(String.init)
        guard !parts.isEmpty, !name.hasPrefix("/"), !parts.contains(where: { $0.hasPrefix(".") }), !name.contains("\\") else { throw AgentArtifactError.fileDenied }
        var current = dup(directory)
        defer { if current >= 0 { close(current) } }
        for (index, part) in parts.enumerated() {
            let last = index == parts.count - 1
            let next = openat(current, part, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (last ? 0 : O_DIRECTORY))
            guard next >= 0 else { throw errno == ENOENT ? AgentArtifactError.fileMissing : AgentArtifactError.fileDenied }
            close(current); current = next
        }
        var info = stat()
        guard fstat(current, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { throw AgentArtifactError.fileDenied }
        guard info.st_size > 0, info.st_size <= 20 * 1024 * 1024 else { throw AgentArtifactError.tooLarge }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = Darwin.read(current, &buffer, buffer.count)
            guard count >= 0 else { throw AgentArtifactError.fileDenied }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
            guard data.count <= 20 * 1024 * 1024 else { throw AgentArtifactError.tooLarge }
        }
        return data
    }
}
