import Foundation

/// Only bounded, non-sensitive facts are retained; no URL, headers or file paths.
public struct UpdateActivity: Equatable, Sendable {
    public enum Stage: String, Sendable {
        case checking = "复查更新信息"
        case downloading = "下载中"
        case verifying = "校验安装包"
        case unpacking = "解压安装包"
        case security = "系统安全校验"
        case installing = "安装中"
        case waiting = "已安装，等待安全重启"
        case relaunching = "已安装，正在重启"
        case restartFailed = "已安装，重启失败"
        case cancelled = "已取消下载"
        case failed = "更新失败"

        public var canCancel: Bool { self == .checking || self == .downloading || self == .verifying }
    }
    public private(set) var stage: Stage = .checking
    public private(set) var stageStarted = Date()
    public private(set) var received = 0
    public private(set) var total: Int
    public private(set) var downloadLabel: String?
    public private(set) var records: [String] = []
    private let started = Date()
    public let version: String

    public init(version: String, size: Int) {
        self.version = version
        self.total = size
        records = ["目标版本：\(version)", "0s · 复查更新信息"]
    }
    public var fraction: Double { min(1, Double(received) / Double(max(1, total))) }
    public var diagnostics: String { records.joined(separator: "\n") }
    public mutating func move(to stage: Stage, now: Date = Date()) {
        guard self.stage != stage else { return }
        record("\(self.stage.rawValue)：\(Int(max(0, now.timeIntervalSince(stageStarted))))s", now: now)
        if self.stage == .downloading && stage == .verifying { received = total }
        self.stage = stage
        stageStarted = now
        record(stage.rawValue, now: now)
    }
    mutating func downloaded(_ progress: UpdateDownload.Progress) {
        guard stage == .downloading else { return }
        received = progress.received
        total = progress.total
        downloadLabel = progress.label
    }
    public mutating func downloadProgress(received: Int, total: Int, elapsed: TimeInterval) {
        downloaded(.init(received: received, total: total, elapsed: elapsed))
    }
    public mutating func record(_ text: String, now: Date = Date()) {
        records.append("\(Int(max(0, now.timeIntervalSince(started))))s · \(text)")
        if records.count > 32 { records.remove(at: 1) }
    }
    public mutating func failed(_ error: Error) {
        record("失败阶段：\(stage.rawValue)；已收 \(received)/\(total) bytes；错误码 \((error as NSError).code)")
        move(to: .failed)
    }
    public func detail(now: Date) -> String {
        let seconds = Int(max(0, now.timeIntervalSince(stageStarted)))
        if stage == .waiting {
            return "新版本 \(version) 已写入磁盘，正在等待节点完成在途启动与回传（\(seconds)s）。不会强退 Agent。"
        }
        if stage == .restartFailed { return "新版本 \(version) 已安装，请手动重新打开客户端。" }
        if stage == .relaunching { return "新版本 \(version) 已安装，等待当前客户端退出后重新打开。" }
        if stage == .downloading { return "\(downloadLabel ?? "等待接收数据") · \(seconds)s" }
        if stage == .failed || stage == .cancelled { return "" }
        return "\(stage.rawValue) · \(seconds)s" + (seconds >= 30 ? "，仍在等待此阶段完成。" : "")
    }
}
