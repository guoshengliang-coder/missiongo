import { createHash, randomBytes, scryptSync } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { AdminAccountConfig } from "./admin-auth.js";
import { MISSIONGO_READ_SCOPE, MissionGoOAuthProvider } from "./oauth.js";

const salt = randomBytes(16);
const account: AdminAccountConfig = {
  id: "account-1",
  username: "mission-owner",
  passwordScrypt: `scrypt:${salt.toString("base64url")}:${scryptSync("correct horse", salt, 64).toString("base64url")}`,
  sessionSecret: "a-long-test-session-secret",
  cookieSecure: true,
};

const REDIRECT_URI = "http://127.0.0.1:9321/callback";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");

let provider: MissionGoOAuthProvider;

beforeEach(() => {
  provider = new MissionGoOAuthProvider(account, "https://missiongo.test");
});

function authorizationInput(overrides: Record<string, unknown> = {}) {
  return {
    clientId: provider.registerClient({ clientName: "Codex", redirectUris: [REDIRECT_URI] }).id,
    redirectUri: REDIRECT_URI,
    responseType: "code",
    scope: MISSIONGO_READ_SCOPE,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    ...overrides,
  } as Parameters<MissionGoOAuthProvider["beginAuthorization"]>[0];
}

describe("client registration", () => {
  it("accepts HTTPS and loopback redirect URIs", () => {
    const client = provider.registerClient({
      clientName: "Codex",
      redirectUris: ["https://client.example/callback", "http://localhost:1234/cb", "http://[::1]:5/cb"],
    });
    expect(client.id.startsWith("mgc_")).toBe(true);
    expect(client.name).toBe("Codex");
  });

  it("rejects redirect URIs that could leak an authorization code", () => {
    const rejected = [
      ["http://client.example/cb"], // plaintext on a non-loopback host
      ["https://client.example/cb#fragment"],
      ["https://user:pass@client.example/cb"],
      ["not-a-url"],
      [],
    ];
    for (const redirectUris of rejected) {
      expect(() => provider.registerClient({ redirectUris })).toThrowError(/invalid_client_metadata/);
    }
    expect(() => provider.registerClient({ redirectUris: Array.from({ length: 11 }, (_, i) => `https://c.example/${i}`) }))
      .toThrowError(/invalid_client_metadata/);
  });

  it("only registers public clients", () => {
    expect(() => provider.registerClient({ redirectUris: [REDIRECT_URI], tokenEndpointAuthMethod: "client_secret_post" }))
      .toThrowError(/invalid_client_metadata/);
  });

  it("rejects a client identifier it did not sign", () => {
    expect(() => provider.beginAuthorization(authorizationInput({ clientId: "mgc_forged.signature" })))
      .toThrowError(/invalid_authorization_request/);
  });
});

describe("authorization request", () => {
  it("requires PKCE with S256 and a code response", () => {
    expect(provider.beginAuthorization(authorizationInput()).clientName).toBe("Codex");

    const rejected = [
      { codeChallengeMethod: "plain" },
      { codeChallengeMethod: "" },
      { responseType: "token" },
      { codeChallenge: "too-short" },
      { codeChallenge: `${challenge}!!` },
      { redirectUri: "https://attacker.example/callback" },
    ];
    for (const overrides of rejected) {
      expect(() => provider.beginAuthorization(authorizationInput(overrides)))
        .toThrowError(/invalid_authorization_request/);
    }
  });

  it("grants read alone unless writing is asked for", () => {
    expect(provider.beginAuthorization(authorizationInput()).scopes).toEqual(["missiongo:read"]);
    expect(provider.beginAuthorization(authorizationInput({ scope: "missiongo:read" })).scopes)
      .toEqual(["missiongo:read"]);
  });

  it("always includes reading when writing is granted", () => {
    // Writing to an item the token cannot read would be a way around the
    // account's product scope, so read comes along whether or not it was asked
    // for.
    expect(provider.beginAuthorization(authorizationInput({ scope: "missiongo:write" })).scopes)
      .toEqual(["missiongo:read", "missiongo:write"]);
    expect(provider.beginAuthorization(authorizationInput({ scope: "missiongo:write missiongo:read" })).scopes)
      .toEqual(["missiongo:read", "missiongo:write"]);
  });

  it("rejects a scope it does not define", () => {
    expect(() => provider.beginAuthorization(authorizationInput({ scope: "missiongo:admin" })))
      .toThrowError(/invalid_scope/);
  });

  it("rejects an expired or tampered authorization request", () => {
    const now = Date.now();
    const { requestToken } = provider.beginAuthorization(authorizationInput(), now);
    expect(() => provider.finishAuthorization(requestToken, now + 11 * 60_000))
      .toThrowError(/invalid_authorization_request/);
    expect(() => provider.finishAuthorization(`${requestToken}tampered`, now))
      .toThrowError(/invalid_authorization_request/);
  });

  it("carries the client state through to the redirect", () => {
    const { requestToken } = provider.beginAuthorization(authorizationInput({ state: "opaque-state" }));
    const completed = provider.finishAuthorization(requestToken);
    expect(completed).toMatchObject({ redirectUri: REDIRECT_URI, state: "opaque-state" });
    expect(completed.code).toHaveLength(43);
  });
});

describe("code exchange", () => {
  function issueCode(now = Date.now()) {
    const { requestToken } = provider.beginAuthorization(authorizationInput(), now);
    return provider.finishAuthorization(requestToken, now);
  }

  function exchange(overrides: Record<string, unknown> = {}, now = Date.now()) {
    const clientId = provider.registerClient({ clientName: "Codex", redirectUris: [REDIRECT_URI] }).id;
    return provider.exchangeCode({
      grantType: "authorization_code",
      code: "",
      clientId,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      ...overrides,
    } as Parameters<MissionGoOAuthProvider["exchangeCode"]>[0], now);
  }

  it("issues a scoped access token for a valid verifier", () => {
    const { code } = issueCode();
    const result = exchange({ code });
    expect(result.principal).toMatchObject({ clientId: expect.stringContaining("mgc_"), scopes: [MISSIONGO_READ_SCOPE] });
    expect(result.accessToken.startsWith("mgai_")).toBe(true);
    expect(result.expiresIn).toBeGreaterThan(0);
  });

  it("carries the granted scope from the consent onto the token", () => {
    const { requestToken } = provider.beginAuthorization(authorizationInput({ scope: "missiongo:write" }));
    const { code } = provider.finishAuthorization(requestToken);
    const result = exchange({ code });
    expect(result.principal.scopes).toEqual(["missiongo:read", "missiongo:write"]);
    expect(result.scope).toBe("missiongo:read missiongo:write");
  });

  it("burns the authorization code after one attempt", () => {
    const { code } = issueCode();
    expect(() => exchange({ code })).not.toThrow();
    expect(() => exchange({ code })).toThrowError(/invalid_grant/);
  });

  it("burns the code even when the attempt fails, so it cannot be brute-forced", () => {
    const { code } = issueCode();
    expect(() => exchange({ code, codeVerifier: randomBytes(32).toString("base64url") })).toThrowError(/invalid_grant/);
    expect(() => exchange({ code })).toThrowError(/invalid_grant/);
  });

  it("rejects a mismatched verifier, client, redirect URI, or grant type", () => {
    for (const overrides of [
      { codeVerifier: randomBytes(32).toString("base64url") },
      { codeVerifier: "short" },
      { clientId: "mgc_someone-else" },
      { redirectUri: "http://127.0.0.1:9321/other" },
      { grantType: "refresh_token" },
    ]) {
      const { code } = issueCode();
      expect(() => exchange({ code, ...overrides })).toThrowError(/invalid_grant/);
    }
  });

  it("rejects an expired authorization code", () => {
    const now = Date.now();
    const { code } = issueCode(now);
    expect(() => exchange({ code }, now + 6 * 60_000)).toThrowError(/invalid_grant/);
  });

  it("rejects an unknown code", () => {
    expect(() => exchange({ code: randomBytes(32).toString("base64url") })).toThrowError(/invalid_grant/);
  });
});
