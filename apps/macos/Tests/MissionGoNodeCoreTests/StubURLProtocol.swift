import Foundation
@testable import MissionGoNodeCore

/// Answers URLSession requests from a table instead of the network.
final class StubURLProtocol: URLProtocol {
    struct Recorded {
        let request: URLRequest
        let body: Data
    }

    enum Reply {
        case response(status: Int, body: String, headers: [String: String] = [:])
        case failure(URLError)
    }

    private static let state = Locked<(handler: ((URLRequest, Data) -> Reply)?, recorded: [Recorded])>((nil, []))

    static func install(_ handler: @escaping (URLRequest, Data) -> Reply) {
        state.withLock { $0 = (handler, []) }
    }

    static var recorded: [Recorded] {
        return state.current.recorded
    }

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool {
        return true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        return request
    }

    override func startLoading() {
        // URLSession moves httpBody into a stream before a protocol sees it.
        let body = request.httpBody ?? StubURLProtocol.readStream(request.httpBodyStream)
        let handler = StubURLProtocol.state.withLock { value -> ((URLRequest, Data) -> Reply)? in
            value.recorded.append(Recorded(request: request, body: body))
            return value.handler
        }
        guard let handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }
        switch handler(request, body) {
        case let .response(status, text, headers):
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(text.utf8))
            client?.urlProtocolDidFinishLoading(self)
        case let .failure(error):
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    private static func readStream(_ stream: InputStream?) -> Data {
        guard let stream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

func jsonObject(_ data: Data) -> [String: Any] {
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
}
