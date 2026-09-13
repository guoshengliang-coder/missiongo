import XCTest
@testable import MissionGoNodeCore

/// RFC 7636 appendix B: these bytes give this verifier and this challenge.
private let rfcBytes: [UInt8] = [
    116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186,
    22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
]

final class PKCETests: XCTestCase {
    func testMatchesTheRFC7636Vector() {
        let pair = PKCE.generate(randomBytes: { count in
            XCTAssertEqual(count, 32)
            return rfcBytes
        })
        XCTAssertEqual(pair.verifier, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        XCTAssertEqual(pair.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testIsDeterministicGivenTheSameRandomness() {
        let fixed: RandomBytes = { count in [UInt8](repeating: 7, count: count) }
        XCTAssertEqual(PKCE.generate(randomBytes: fixed), PKCE.generate(randomBytes: fixed))
        XCTAssertEqual(PKCE.state(randomBytes: fixed), PKCE.state(randomBytes: fixed))
    }

    func testRealRandomnessHasTheRequiredShape() {
        let verifierShape = AnchoredPattern("[A-Za-z0-9._~-]{43,128}")
        let challengeShape = AnchoredPattern("[A-Za-z0-9_-]{43,}")
        var seen = Set<String>()
        for _ in 0..<20 {
            let pair = PKCE.generate()
            XCTAssertTrue(verifierShape.matches(pair.verifier), pair.verifier)
            XCTAssertTrue(challengeShape.matches(pair.challenge), pair.challenge)
            XCTAssertFalse(pair.challenge.contains("="))
            XCTAssertEqual(pair.challenge, PKCE.challenge(for: pair.verifier))
            seen.insert(pair.verifier)
        }
        XCTAssertEqual(seen.count, 20)
        XCTAssertNotEqual(PKCE.state(), PKCE.state())
    }
}

final class OAuthRequestsTests: XCTestCase {
    func testAuthorizeURLIsExact() {
        let url = OAuthRequests.authorizeURL(
            serverUrl: "https://missiongo.example/",
            clientId: "client-123",
            redirectURI: OAuthRequests.redirectURI(port: 53123),
            codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            state: "st_ate-1"
        )
        XCTAssertEqual(
            url?.absoluteString,
            "https://missiongo.example/oauth/authorize?response_type=code&client_id=client-123"
                + "&redirect_uri=http://127.0.0.1:53123/callback"
                + "&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"
                + "&state=st_ate-1&scope=missiongo:read%20missiongo:node"
        )
    }

    func testAuthorizeURLEscapesValuesThatCouldSplitTheQuery() {
        let url = OAuthRequests.authorizeURL(
            serverUrl: "https://missiongo.example", clientId: "a&b=c d+e?", redirectURI: "http://127.0.0.1:1/callback",
            codeChallenge: "x", state: "y"
        )
        XCTAssertTrue(url?.absoluteString.contains("client_id=a%26b%3Dc%20d%2Be%3F&") == true, url?.absoluteString ?? "")
    }

    func testFormEncoding() {
        XCTAssertEqual(
            OAuthRequests.formEncode([("a", "b c"), ("redirect_uri", "http://127.0.0.1:5/callback"), ("x", "1+2&3=4~")]),
            "a=b+c&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcallback&x=1%2B2%263%3D4%7E"
        )
        XCTAssertEqual(
            OAuthRequests.tokenRequestBody(
                code: "code-1", clientId: "client-1", redirectURI: "http://127.0.0.1:5/callback", codeVerifier: "v_1.~"
            ),
            "grant_type=authorization_code&code=code-1&client_id=client-1"
                + "&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcallback&code_verifier=v_1.%7E"
        )
    }

    func testCallbackReturnsTheCodeWhenStateMatches() throws {
        XCTAssertEqual(
            try OAuthRequests.parseCallback(target: "/callback?code=abc%2Fdef&state=s1", expectedState: "s1"),
            "abc/def"
        )
    }

    func testCallbackRefusesAStateMismatch() {
        XCTAssertThrowsError(try OAuthRequests.parseCallback(target: "/callback?code=abc&state=other", expectedState: "s1")) {
            XCTAssertEqual($0 as? OAuthLoginError, .stateMismatch)
        }
        XCTAssertThrowsError(try OAuthRequests.parseCallback(target: "/callback?code=abc", expectedState: "s1")) {
            XCTAssertEqual($0 as? OAuthLoginError, .stateMismatch)
        }
    }

    func testCallbackReportsTheErrorParameter() {
        XCTAssertThrowsError(try OAuthRequests.parseCallback(
            target: "/callback?error=access_denied&error_description=user+said+no&state=s1", expectedState: "s1"
        )) {
            XCTAssertEqual($0 as? OAuthLoginError, .authorizationDenied(error: "access_denied", description: "user said no"))
        }
        // An error callback that is not ours is still a mismatch, not a denial.
        XCTAssertThrowsError(try OAuthRequests.parseCallback(target: "/callback?error=access_denied&state=x", expectedState: "s1")) {
            XCTAssertEqual($0 as? OAuthLoginError, .stateMismatch)
        }
    }

    func testCallbackWithoutACode() {
        XCTAssertThrowsError(try OAuthRequests.parseCallback(target: "/callback?state=s1", expectedState: "s1")) {
            XCTAssertEqual($0 as? OAuthLoginError, .missingCode)
        }
    }

    func testRequestLineAndPathParsing() {
        let parsed = LoopbackCallbackListener.parseRequestLine(Data("GET /callback?code=1 HTTP/1.1\r\nHost: x\r\n\r\n".utf8))
        XCTAssertEqual(parsed.method, "GET")
        XCTAssertEqual(parsed.target, "/callback?code=1")
        XCTAssertEqual(OAuthRequests.path(ofTarget: "/callback?code=1"), "/callback")
        XCTAssertEqual(OAuthRequests.path(ofTarget: "/callbackx"), "/callbackx")
    }
}

final class OAuthLoginFlowTests: XCTestCase {
    private let server = "http://mg.test"

    private func installServer(tokenScope: String = "missiongo:read missiongo:node") {
        StubURLProtocol.install { request, _ in
            switch request.url?.path {
            case "/oauth/register":
                return .response(status: 201, body: #"{"client_id":"client-xyz","client_name":"MissionGo macOS"}"#)
            case "/oauth/token":
                return .response(status: 200, body: #"{"access_token":"mgai_secret","token_type":"Bearer","expires_in":2592000,"scope":"\#(tokenScope)"}"#)
            case "/api/v1/node/register":
                return .response(status: 201, body: #"{"nodeId":"n1","name":"Mac mini","token":"mgn_node"}"#)
            default:
                return .response(status: 404, body: "")
            }
        }
    }

    /// Plays the browser: follows the authorize URL straight to the loopback
    /// callback with the given code and state, over a real local connection.
    private func browser(state override: String? = nil, pages: Locked<[String]>) -> URLOpener {
        return { url in
            let query = OAuthRequests.parseQuery(url.absoluteString)
            let redirect = try XCTUnwrap(query["redirect_uri"])
            let state = override ?? query["state"] ?? ""
            let plain = URLSession(configuration: .ephemeral)
            // A stray request first: it must be refused without ending the login.
            let (_, favicon) = try await plain.data(from: URL(string: redirect.replacingOccurrences(of: "/callback", with: "/favicon.ico"))!)
            XCTAssertEqual((favicon as? HTTPURLResponse)?.statusCode, 404)
            let (data, response) = try await plain.data(from: URL(string: "\(redirect)?code=the-code&state=\(state)")!)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            XCTAssertEqual((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type"), "text/html; charset=utf-8")
            pages.withLock { $0.append(String(decoding: data, as: UTF8.self)) }
        }
    }

    func testFullLoginEndsInANodeCredential() async throws {
        installServer()
        let pages = Locked<[String]>([])
        let authorizeQueries = Locked<[[String: String]]>([])
        let follow = browser(pages: pages)
        let login = OAuthLogin(serverUrl: server, session: StubURLProtocol.session(), openURL: { url in
            authorizeQueries.withLock { $0.append(OAuthRequests.parseQuery(url.absoluteString)) }
            try await follow(url)
        })
        let credential = try await login.run(installationId: "inst-1", name: "Mac mini", hostname: "mini.local")

        XCTAssertEqual(credential, NodeCredential(serverUrl: server, nodeId: "n1", name: "Mac mini", token: "mgn_node"))
        XCTAssertTrue(pages.current.first?.contains("登录完成，可以回到 MissionGo 客户端了。") == true)

        let recorded = StubURLProtocol.recorded
        XCTAssertEqual(recorded.map { $0.request.url?.path }, ["/oauth/register", "/oauth/token", "/api/v1/node/register"])

        let registration = jsonObject(recorded[0].body)
        let redirect = try XCTUnwrap((registration["redirect_uris"] as? [String])?.first)
        XCTAssertTrue(AnchoredPattern("http://127\\.0\\.0\\.1:[0-9]+/callback").matches(redirect), redirect)
        XCTAssertEqual(registration["client_name"] as? String, "MissionGo macOS")
        XCTAssertEqual(registration["token_endpoint_auth_method"] as? String, "none")

        let token = recorded[1]
        XCTAssertEqual(token.request.value(forHTTPHeaderField: "Content-Type"), "application/x-www-form-urlencoded")
        let form = OAuthRequests.parseQuery("?" + String(decoding: token.body, as: UTF8.self))
        XCTAssertEqual(form["grant_type"], "authorization_code")
        XCTAssertEqual(form["code"], "the-code")
        XCTAssertEqual(form["client_id"], "client-xyz")
        // Exactly the redirect URI that was registered.
        XCTAssertEqual(form["redirect_uri"], redirect)
        // The verifier sent at the end belongs to the challenge the browser carried.
        let verifier = try XCTUnwrap(form["code_verifier"])
        XCTAssertEqual(PKCE.challenge(for: verifier), authorizeQueries.current.first?["code_challenge"])
        XCTAssertEqual(authorizeQueries.current.first?["code_challenge_method"], "S256")
        XCTAssertEqual(authorizeQueries.current.first?["redirect_uri"], redirect)
        XCTAssertEqual(authorizeQueries.current.first?["scope"], "missiongo:read missiongo:node")

        XCTAssertEqual(recorded[2].request.value(forHTTPHeaderField: "Authorization"), "Bearer mgai_secret")
    }

    func testAStateMismatchFailsTheLoginAndTellsTheBrowser() async {
        installServer()
        let pages = Locked<[String]>([])
        let login = OAuthLogin(serverUrl: server, session: StubURLProtocol.session(), openURL: browser(state: "forged", pages: pages))
        do {
            _ = try await login.run(installationId: "inst-1", name: "Mac", hostname: "mac")
            XCTFail("expected a state mismatch")
        } catch {
            XCTAssertEqual(error as? OAuthLoginError, .stateMismatch)
        }
        XCTAssertTrue(pages.current.first?.contains("登录没有完成") == true)
        // No code exchange for a callback that is not ours.
        XCTAssertFalse(StubURLProtocol.recorded.contains { $0.request.url?.path == "/oauth/token" })
    }

    func testAMissingNodeScopeIsExplained() async {
        installServer(tokenScope: "missiongo:read")
        let login = OAuthLogin(serverUrl: server, session: StubURLProtocol.session(), openURL: browser(pages: Locked([])))
        do {
            _ = try await login.run(installationId: "inst-1", name: "Mac", hostname: "mac")
            XCTFail("expected missingNodeScope")
        } catch {
            XCTAssertEqual(error as? OAuthLoginError, .missingNodeScope(granted: "missiongo:read"))
        }
    }

    func testGivesUpAfterTheTimeout() async {
        installServer()
        let login = OAuthLogin(serverUrl: server, session: StubURLProtocol.session(), timeout: 0.5, openURL: { _ in })
        do {
            _ = try await login.run(installationId: "inst-1", name: "Mac", hostname: "mac")
            XCTFail("expected a timeout")
        } catch {
            XCTAssertEqual(error as? OAuthLoginError, .timedOut)
        }
    }

    func testCanBeCancelled() async {
        installServer()
        let opened = expectation(description: "browser opened")
        let login = OAuthLogin(serverUrl: server, session: StubURLProtocol.session(), openURL: { _ in opened.fulfill() })
        let task = Task { try await login.run(installationId: "inst-1", name: "Mac", hostname: "mac") }
        await fulfillment(of: [opened], timeout: 5)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError, "\(error)")
        }
    }
}
