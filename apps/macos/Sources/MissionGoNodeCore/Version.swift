import Foundation

/// Comparing the dotted version numbers this project publishes: the Skill's
/// front-matter `version`, and the macOS client's `CFBundleShortVersionString`.
///
/// Numeric part by part, never as strings: `5.10.0` is newer than `5.9.0`, and
/// a lexicographic compare would say the opposite. Missing parts count as zero,
/// so `5.3` and `5.3.0` are the same version.
public enum Version {
    /// The parts, or nil for anything that is not all numbers -- a pre-release
    /// tag, a git describe, an HTML error page read as a version.
    public static func numericParts(_ version: String) -> [Int]? {
        let parts = version.split(separator: ".").map { Int($0) }
        guard !parts.isEmpty, parts.allSatisfy({ $0 != nil }) else { return nil }
        return parts.compactMap { $0 }
    }

    /// False when either side is unreadable: refusing to act beats guessing
    /// which of two versions we could not parse is newer.
    public static func isNewer(_ candidate: String, than current: String) -> Bool {
        guard let lhs = numericParts(candidate), let rhs = numericParts(current) else { return false }
        for index in 0..<max(lhs.count, rhs.count) {
            let a = index < lhs.count ? lhs[index] : 0
            let b = index < rhs.count ? rhs[index] : 0
            if a != b { return a > b }
        }
        return false
    }
}
