import Foundation

/// An update owns this session: cancelling it never cancels node/API traffic.
final class UpdateDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    struct Progress: Equatable, Sendable {
        let received: Int
        let total: Int
        let elapsed: TimeInterval
        var fraction: Double { min(1, Double(received) / Double(max(1, total))) }
        var label: String {
            let bytes = ByteCountFormatter.string(fromByteCount: Int64(received), countStyle: .decimal)
            let size = ByteCountFormatter.string(fromByteCount: Int64(total), countStyle: .decimal)
            let rate = elapsed >= 1 ? " · \(ByteCountFormatter.string(fromByteCount: Int64(Double(received) / elapsed), countStyle: .decimal))/s" : ""
            return "\(bytes) / \(size)\(rate)"
        }
    }

    private struct State {
        var continuation: CheckedContinuation<Data, Error>?
        var task: URLSessionDataTask?
        var cancelled = false
        var finished = false
        var data = Data()
        var lastProgress = -Double.infinity
    }
    private let state = Locked(State())
    private let expected: Int
    private let started = ProcessInfo.processInfo.systemUptime
    private let progress: @Sendable (Progress) -> Void
    private let metrics: @Sendable (String) -> Void

    init(expected: Int, progress: @escaping @Sendable (Progress) -> Void, metrics: @escaping @Sendable (String) -> Void) {
        self.expected = expected
        self.progress = progress
        self.metrics = metrics
    }

    func run(request: URLRequest, configuration: URLSessionConfiguration) async throws -> Data {
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                state.withLock { value in
                    if value.cancelled || Task.isCancelled {
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    value.continuation = continuation
                    let task = session.dataTask(with: request)
                    value.task = task
                    task.resume()
                }
            }
        } onCancel: {
            let task = self.state.withLock { value -> URLSessionDataTask? in
                value.cancelled = true
                return value.task
            }
            task?.cancel()
        }
    }

    private func finish(_ result: Result<Data, Error>) {
        let continuation = state.withLock { value -> CheckedContinuation<Data, Error>? in
            guard !value.finished else { return nil }
            value.finished = true
            value.task = nil
            let continuation = value.continuation
            value.continuation = nil
            return continuation
        }
        continuation?.resume(with: result)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            completionHandler(.cancel)
            finish(.failure(AppUpdater.UpdateError.download("HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")))
            return
        }
        guard response.expectedContentLength < 0 || response.expectedContentLength == Int64(expected) else {
            completionHandler(.cancel)
            finish(.failure(AppUpdater.UpdateError.download("安装包大小与更新信息不一致，请重新检查更新。")))
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let elapsed = ProcessInfo.processInfo.systemUptime - started
        let result = state.withLock { value -> (overflow: Bool, event: Progress?) in
            guard !value.finished else { return (false, nil) }
            guard data.count <= expected - value.data.count else { return (true, nil) }
            value.data.append(data)
            guard elapsed - value.lastProgress >= 1 || value.data.count == expected else { return (false, nil) }
            value.lastProgress = elapsed
            return (false, Progress(received: value.data.count, total: expected, elapsed: elapsed))
        }
        if result.overflow {
            dataTask.cancel()
            finish(.failure(AppUpdater.UpdateError.download("安装包超过声明大小，已停止下载。")))
        } else if let event = result.event { progress(event) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        let duration = metrics.taskInterval.duration
        let firstByte = metrics.transactionMetrics.first.flatMap { metric -> TimeInterval? in
            guard let start = metric.fetchStartDate, let response = metric.responseStartDate else { return nil }
            return response.timeIntervalSince(start)
        }
        self.metrics(String(format: "网络耗时 %.2fs", duration) + (firstByte.map { String(format: "，首字节 %.2fs", $0) } ?? ""))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if state.withLock({ $0.cancelled }) { finish(.failure(CancellationError())); return }
        if let error { finish(.failure(error)); return }
        let data = state.withLock { $0.data }
        guard data.count == expected else {
            finish(.failure(AppUpdater.UpdateError.digestMismatch))
            return
        }
        progress(Progress(received: data.count, total: expected, elapsed: ProcessInfo.processInfo.systemUptime - started))
        finish(.success(data))
    }
}
