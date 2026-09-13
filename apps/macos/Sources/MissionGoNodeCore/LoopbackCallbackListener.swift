import Foundation
import Network

/// The one HTTP request the browser sends back at the end of a login, answered
/// and then closed.
///
/// Bound to 127.0.0.1 on a port the OS picks, so it is never reachable from
/// another machine, even for the few minutes a login takes, and two logins (or
/// another app) never fight over a fixed port.
final class LoopbackCallbackListener: @unchecked Sendable {
    static let callbackPath = "/callback"
    static let maxRequestBytes = 64 * 1024

    private let queue = DispatchQueue(label: "io.missiongo.macos.oauth-callback")
    private let listener: NWListener
    /// Turns the callback's request target into the page the browser shows. Set
    /// before the browser is opened: the callback can arrive before anyone is
    /// awaiting it, and it must still get the right page.
    private let respond: @Sendable (String) -> String
    private let state = Locked(State())

    private struct State {
        var ready: CheckedContinuation<UInt16, Error>?
        var callback: CheckedContinuation<String, Error>?
        var delivered: String?
        var failure: Error?
    }

    init(respond: @escaping @Sendable (String) -> String) throws {
        self.respond = respond
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        do {
            listener = try NWListener(using: parameters)
        } catch {
            throw OAuthLoginError.listenerFailed(error.localizedDescription)
        }
    }

    /// Starts listening and returns the port the OS assigned.
    func start() async throws -> UInt16 {
        return try await withCheckedThrowingContinuation { continuation in
            let failure: Error? = state.withLock { value in
                if let failure = value.failure { return failure }
                value.ready = continuation
                return nil
            }
            if let failure { return continuation.resume(throwing: failure) }

            listener.stateUpdateHandler = { [weak self] update in
                guard let self else { return }
                switch update {
                case .ready:
                    let pending = self.state.withLock { value -> CheckedContinuation<UInt16, Error>? in
                        defer { value.ready = nil }
                        return value.ready
                    }
                    if let port = self.listener.port?.rawValue {
                        pending?.resume(returning: port)
                    } else {
                        pending?.resume(throwing: OAuthLoginError.listenerFailed("系统没有分配端口"))
                    }
                case let .failed(error):
                    self.finish(OAuthLoginError.listenerFailed(error.localizedDescription))
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                guard let self else { return connection.cancel() }
                connection.start(queue: self.queue)
                self.receive(connection, buffer: Data())
            }
            listener.start(queue: queue)
        }
    }

    /// Waits for `GET /callback` and returns its request target.
    func waitForCallback() async throws -> String {
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
                enum Next {
                    case deliver(String)
                    case fail(Error)
                    case wait
                }
                let next: Next = state.withLock { value in
                    if let delivered = value.delivered { return .deliver(delivered) }
                    if let failure = value.failure { return .fail(failure) }
                    value.callback = continuation
                    return .wait
                }
                switch next {
                case let .deliver(target): continuation.resume(returning: target)
                case let .fail(error): continuation.resume(throwing: error)
                case .wait: break
                }
            }
        } onCancel: {
            self.cancel()
        }
    }

    /// Stops listening. Safe to call more than once and after a callback.
    func cancel() {
        finish(CancellationError())
    }

    private func finish(_ error: Error) {
        let pending = state.withLock { value -> (CheckedContinuation<UInt16, Error>?, CheckedContinuation<String, Error>?) in
            if value.failure == nil { value.failure = error }
            defer {
                value.ready = nil
                value.callback = nil
            }
            return (value.ready, value.callback)
        }
        listener.cancel()
        pending.0?.resume(throwing: error)
        pending.1?.resume(throwing: error)
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return connection.cancel() }
            var buffer = buffer
            if let data { buffer.append(data) }
            let headersComplete = buffer.range(of: Data("\r\n\r\n".utf8)) != nil
            if !headersComplete, !isComplete, error == nil, buffer.count < LoopbackCallbackListener.maxRequestBytes {
                return self.receive(connection, buffer: buffer)
            }
            self.answer(connection, request: buffer)
        }
    }

    private func answer(_ connection: NWConnection, request: Data) {
        let (method, target) = LoopbackCallbackListener.parseRequestLine(request)

        // Anything but the callback — a favicon request, a stray probe — gets a 404
        // and the listener keeps waiting for the real one.
        guard method == "GET", OAuthRequests.path(ofTarget: target) == LoopbackCallbackListener.callbackPath else {
            return send(connection, LoopbackCallbackListener.httpResponse(status: "404 Not Found", html: ""))
        }

        let waiting = state.withLock { value -> (claimed: Bool, continuation: CheckedContinuation<String, Error>?) in
            // Only the first callback counts; reloading the page is not a second login.
            guard value.delivered == nil, value.failure == nil else { return (false, nil) }
            value.delivered = target
            defer { value.callback = nil }
            return (true, value.callback)
        }
        guard waiting.claimed else {
            return send(connection, LoopbackCallbackListener.httpResponse(status: "410 Gone", html: CallbackPages.stale))
        }
        let page = LoopbackCallbackListener.httpResponse(status: "200 OK", html: respond(target))
        connection.send(content: page, completion: .contentProcessed { [weak self] _ in
            connection.cancel()
            self?.listener.cancel()
        })
        waiting.continuation?.resume(returning: target)
    }

    private func send(_ connection: NWConnection, _ data: Data) {
        connection.send(content: data, completion: .contentProcessed { _ in connection.cancel() })
    }

    /// `GET /callback?code=… HTTP/1.1` → ("GET", "/callback?code=…").
    static func parseRequestLine(_ request: Data) -> (method: String, target: String) {
        let text = String(decoding: request, as: UTF8.self)
        let line = text.components(separatedBy: "\r\n").first ?? ""
        let parts = line.split(separator: " ", omittingEmptySubsequences: true)
        return (parts.count > 0 ? String(parts[0]) : "", parts.count > 1 ? String(parts[1]) : "")
    }

    static func httpResponse(status: String, html: String) -> Data {
        let body = Data(html.utf8)
        let head = [
            "HTTP/1.1 \(status)",
            "Content-Type: text/html; charset=utf-8",
            "Content-Length: \(body.count)",
            "Cache-Control: no-store",
            "Connection: close",
            "",
            "",
        ].joined(separator: "\r\n")
        return Data(head.utf8) + body
    }
}
