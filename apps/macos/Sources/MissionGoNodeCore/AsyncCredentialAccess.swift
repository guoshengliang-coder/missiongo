import Foundation

/// A Security.framework call may never return and cannot be cancelled by Swift.
/// The deadline ends the caller's wait without awaiting that system call. Only
/// one call may remain outstanding, so retries cannot exhaust worker threads or
/// race a late save/delete. A busy store needs system recovery or an app restart.
public final class AsyncCredentialAccess: @unchecked Sendable {
    private let busy = Locked(false)
    private let queue = DispatchQueue(label: "credential-access", qos: .userInitiated)

    public init() {}

    public func run<Value: Sendable>(timeout: TimeInterval = 10, operation: @escaping @Sendable () throws -> Value) async throws -> Value {
        try Task.checkCancellation()
        let reserved = busy.withLock { value -> Bool in
            if value { return false }
            value = true
            return true
        }
        guard reserved else {
            throw CredentialStoreError(message: "系统钥匙串操作仍未返回。请在「钥匙串访问」中检查授权，或退出并重新打开客户端后重试。")
        }
        let waiter = CredentialWaiter<Value>()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                waiter.install(continuation)
                DispatchQueue.global().asyncAfter(deadline: .now() + max(0, timeout)) {
                    waiter.finish(.failure(CredentialStoreError(message: "等待钥匙串超时。界面仍可使用；请检查系统授权提示，必要时退出并重新打开客户端。")))
                }
                queue.async { [self] in
                    guard !waiter.finished else { busy.withLock { $0 = false }; return }
                    let result = Result { try operation() }
                    busy.withLock { $0 = false }
                    waiter.finish(result)
                }
            }
        }, onCancel: {
            waiter.finish(.failure(CancellationError()))
        })
    }
}

private final class CredentialWaiter<Value: Sendable>: @unchecked Sendable {
    private struct State {
        var continuation: CheckedContinuation<Value, Error>?
        var result: Result<Value, Error>?
    }
    private let state = Locked(State())
    var finished: Bool { state.current.result != nil }

    func install(_ continuation: CheckedContinuation<Value, Error>) {
        let result = state.withLock { value -> Result<Value, Error>? in
            if let result = value.result { return result }
            value.continuation = continuation
            return nil
        }
        if let result { continuation.resume(with: result) }
    }

    func finish(_ result: Result<Value, Error>) {
        let continuation = state.withLock { value -> CheckedContinuation<Value, Error>? in
            guard value.result == nil else { return nil }
            value.result = result
            let continuation = value.continuation
            value.continuation = nil
            return continuation
        }
        continuation?.resume(with: result)
    }
}
