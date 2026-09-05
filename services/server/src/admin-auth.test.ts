import { randomBytes, scryptSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ADMIN_SESSION_SECONDS,
  adminSessionCookie,
  createAdminSession,
  createAiAccessToken,
  expiredAdminSessionCookie,
  readAdminSession,
  readAiAccessToken,
  verifyAdminCredentials,
  type AdminAccountConfig,
} from "./admin-auth.js";

const salt = randomBytes(16);

function account(overrides: Partial<AdminAccountConfig> = {}): AdminAccountConfig {
  return {
    id: "account-1",
    username: "mission-owner",
    passwordScrypt: `scrypt:${salt.toString("base64url")}:${scryptSync("correct horse", salt, 64).toString("base64url")}`,
    sessionSecret: "a-long-test-session-secret",
    cookieSecure: true,
    ...overrides,
  };
}

describe("verifyAdminCredentials", () => {
  it("accepts the configured credentials", () => {
    expect(verifyAdminCredentials(account(), "mission-owner", "correct horse")).toBe(true);
  });

  it("rejects a wrong password, username, or case variant", () => {
    expect(verifyAdminCredentials(account(), "mission-owner", "correct horse ")).toBe(false);
    expect(verifyAdminCredentials(account(), "someone-else", "correct horse")).toBe(false);
    expect(verifyAdminCredentials(account(), "Mission-Owner", "correct horse")).toBe(false);
    expect(verifyAdminCredentials(account(), "", "")).toBe(false);
  });

  it("rejects oversized input before hashing it", () => {
    expect(verifyAdminCredentials(account(), "mission-owner", "x".repeat(1_025))).toBe(false);
    expect(verifyAdminCredentials(account(), "x".repeat(129), "correct horse")).toBe(false);
  });

  it("rejects a malformed stored digest instead of trusting it", () => {
    const cases = [
      "bcrypt:c2FsdA:aGFzaA",
      `scrypt:${Buffer.from("short").toString("base64url")}:${scryptSync("correct horse", salt, 64).toString("base64url")}`,
      `scrypt:${salt.toString("base64url")}:${scryptSync("correct horse", salt, 32).toString("base64url")}`,
      `scrypt:${salt.toString("base64url")}`,
      "",
    ];
    for (const passwordScrypt of cases) {
      expect(verifyAdminCredentials(account({ passwordScrypt }), "mission-owner", "correct horse")).toBe(false);
    }
  });

  it("supports both the ':' and '$' digest separators", () => {
    const dollar = account().passwordScrypt.replaceAll(":", "$");
    expect(verifyAdminCredentials(account({ passwordScrypt: dollar }), "mission-owner", "correct horse")).toBe(true);
  });
});

describe("admin session tokens", () => {
  it("round-trips the signed session", () => {
    const config = account();
    expect(readAdminSession(config, createAdminSession(config))).toEqual({
      id: "account-1",
      username: "mission-owner",
      role: "admin",
    });
  });

  it("rejects a tampered payload, signature, or secret", () => {
    const config = account();
    const token = createAdminSession(config);
    const [payload, signature] = token.split(".") as [string, string];

    const forged = Buffer.from(JSON.stringify({
      version: 1,
      id: "account-1",
      username: "mission-owner",
      role: "admin",
      issuedAt: Math.floor(Date.now() / 1_000),
      expiresAt: Math.floor(Date.now() / 1_000) + 10_000,
    })).toString("base64url");

    // The final base64url character of a 32-byte HMAC encodes only four bits, so
    // it takes one of sixteen values and is already "A" about 6% of the time.
    // Appending a fixed "A" would leave the signature unchanged on those runs
    // and the assertion would be handed a perfectly valid token.
    const brokenSignature = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;

    expect(readAdminSession(config, `${forged}.${signature}`)).toBeUndefined();
    expect(readAdminSession(config, `${payload}.${brokenSignature}`)).toBeUndefined();
    expect(readAdminSession(account({ sessionSecret: "another-secret" }), token)).toBeUndefined();
    expect(readAdminSession(config, payload)).toBeUndefined();
    expect(readAdminSession(config, `${payload}.${signature}.extra`)).toBeUndefined();
  });

  it("rejects an expired session and one issued in the future", () => {
    const config = account();
    const issuedAt = Date.now();
    const token = createAdminSession(config, issuedAt);
    expect(readAdminSession(config, token, issuedAt + ADMIN_SESSION_SECONDS * 1_000 + 1_000)).toBeUndefined();
    expect(readAdminSession(config, token, issuedAt - 120_000)).toBeUndefined();
  });

  it("stops accepting a session after the account identity changes", () => {
    const config = account();
    const token = createAdminSession(config);
    expect(readAdminSession(account({ username: "renamed" }), token)).toBeUndefined();
    expect(readAdminSession(account({ id: "account-2" }), token)).toBeUndefined();
  });

  it("marks the cookie HttpOnly, SameSite=Strict, and Secure when configured", () => {
    const cookie = adminSessionCookie(account(), "token-value");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(adminSessionCookie(account({ cookieSecure: false }), "token-value")).not.toContain("Secure");
    expect(expiredAdminSessionCookie(account())).toContain("Max-Age=0");
  });
});

describe("AI access tokens", () => {
  it("carries the client, scope, and all-product permission", () => {
    const config = account();
    const { token } = createAiAccessToken(config, "codex-client");
    expect(readAiAccessToken(config, token)).toMatchObject({
      id: "account-1",
      clientId: "codex-client",
      scopes: ["missiongo:read"],
      productIds: "*",
    });
  });

  it("re-reads the product scope from configuration on every verification", () => {
    // A token minted while the account could read everything must not keep that
    // access after the deployment narrows ADMIN_AUTHORIZED_PRODUCT_IDS.
    const { token } = createAiAccessToken(account(), "codex-client");
    const narrowed = readAiAccessToken(account({ authorizedProductIds: ["product-a"] }), token);
    expect(narrowed?.productIds).toEqual(["product-a"]);
  });

  it("does not accept a session token, and the session reader does not accept it", () => {
    const config = account();
    const sessionToken = createAdminSession(config);
    const { token: aiToken } = createAiAccessToken(config, "codex-client");

    expect(readAiAccessToken(config, sessionToken)).toBeUndefined();
    expect(readAdminSession(config, aiToken)).toBeUndefined();
  });

  it("rejects a tampered token or a foreign secret", () => {
    const config = account();
    const { token } = createAiAccessToken(config, "codex-client");
    const body = token.slice("mgai_".length);
    const [payload, signature] = body.split(".") as [string, string];

    const brokenSignature = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    expect(readAiAccessToken(config, `mgai_${payload}.${brokenSignature}`)).toBeUndefined();
    expect(readAiAccessToken(config, body)).toBeUndefined();
    expect(readAiAccessToken(account({ sessionSecret: "another-secret" }), token)).toBeUndefined();
  });

  it("rejects an expired token", () => {
    const config = account();
    const issuedAt = Date.now();
    const { token, principal } = createAiAccessToken(config, "codex-client", ["missiongo:read"], issuedAt);
    expect(readAiAccessToken(config, token, principal.expiresAt * 1_000 + 1_000)).toBeUndefined();
  });
});
