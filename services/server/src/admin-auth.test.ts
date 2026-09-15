import { randomBytes, scryptSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ADMIN_SESSION_SECONDS,
  adminSessionCookie,
  createAdminSession,
  createAiAccessToken,
  expiredAdminSessionCookie,
  hashPassword,
  readAdminSession,
  readAiAccessToken,
  verifyPassword,
  type AdminAccountConfig,
  type AdminSessionUser,
} from "./admin-auth.js";

const salt = randomBytes(16);
const storedDigest = `scrypt:${salt.toString("base64url")}:${scryptSync("correct horse", salt, 64).toString("base64url")}`;

function account(overrides: Partial<AdminAccountConfig> = {}): AdminAccountConfig {
  return {
    id: "account-1",
    username: "owner@example.com",
    passwordScrypt: storedDigest,
    sessionSecret: "a-long-test-session-secret",
    cookieSecure: true,
    ...overrides,
  };
}

function user(overrides: Partial<AdminSessionUser> = {}): AdminSessionUser {
  return { id: "account-1", username: "owner@example.com", role: "admin", ...overrides };
}

describe("password digests", () => {
  it("accepts the stored password", () => {
    expect(verifyPassword(storedDigest, "correct horse")).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(verifyPassword(storedDigest, "correct horse ")).toBe(false);
    expect(verifyPassword(storedDigest, "")).toBe(false);
  });

  it("rejects oversized input before hashing it", () => {
    expect(verifyPassword(storedDigest, "x".repeat(1_025))).toBe(false);
  });

  it("rejects a malformed stored digest instead of trusting it", () => {
    const cases = [
      "bcrypt:c2FsdA:aGFzaA",
      `scrypt:${Buffer.from("short").toString("base64url")}:${scryptSync("correct horse", salt, 64).toString("base64url")}`,
      `scrypt:${salt.toString("base64url")}:${scryptSync("correct horse", salt, 32).toString("base64url")}`,
      `scrypt:${salt.toString("base64url")}`,
      "",
    ];
    for (const digest of cases) {
      expect(verifyPassword(digest, "correct horse")).toBe(false);
    }
  });

  it("supports both the ':' and '$' digest separators", () => {
    expect(verifyPassword(storedDigest.replaceAll(":", "$"), "correct horse")).toBe(true);
  });

  it("produces a digest the same verifier accepts, with a fresh salt each time", () => {
    const first = hashPassword("a new long password");
    const second = hashPassword("a new long password");
    expect(verifyPassword(first, "a new long password")).toBe(true);
    expect(verifyPassword(second, "a new long password")).toBe(true);
    expect(verifyPassword(first, "a different password")).toBe(false);
    // Equal passwords must not produce equal digests, or the stored table leaks
    // which accounts share one.
    expect(first).not.toEqual(second);
  });

  it("matches the digest shape scripts/create-admin-password-hash.mjs writes", () => {
    expect(hashPassword("a new long password")).toMatch(/^scrypt:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{86}$/);
  });
});

describe("admin session tokens", () => {
  it("round-trips the signed session", () => {
    const config = account();
    expect(readAdminSession(config, createAdminSession(config, user()))).toMatchObject({
      id: "account-1",
      username: "owner@example.com",
      role: "admin",
    });
  });

  it("carries the issue time, which is what the accounts table checks a session against", () => {
    const config = account();
    const issuedAt = Date.now();
    const claims = readAdminSession(config, createAdminSession(config, user(), issuedAt));
    expect(claims?.issuedAt).toBe(Math.floor(issuedAt / 1_000));
  });

  it("signs a member session as a member", () => {
    const config = account();
    const token = createAdminSession(config, user({ id: "account-2", username: "member@example.com", role: "member" }));
    expect(readAdminSession(config, token)).toMatchObject({ id: "account-2", role: "member" });
  });

  it("rejects a tampered payload, signature, or secret", () => {
    const config = account();
    const token = createAdminSession(config, user());
    const [payload, signature] = token.split(".") as [string, string];

    const forged = Buffer.from(JSON.stringify({
      version: 1,
      id: "account-1",
      username: "owner@example.com",
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

  it("rejects a session claiming a role that does not exist", () => {
    const config = account();
    const forged = Buffer.from(JSON.stringify({
      version: 1,
      id: "account-1",
      username: "owner@example.com",
      role: "superuser",
      issuedAt: Math.floor(Date.now() / 1_000),
      expiresAt: Math.floor(Date.now() / 1_000) + 10_000,
    })).toString("base64url");
    // Signed with the real secret, so only the shape check can catch it.
    const signed = createAdminSession(config, user());
    const secretSignature = signed.split(".")[1]!;
    expect(readAdminSession(config, `${forged}.${secretSignature}`)).toBeUndefined();
  });

  it("rejects an expired session and one issued in the future", () => {
    const config = account();
    const issuedAt = Date.now();
    const token = createAdminSession(config, user(), issuedAt);
    expect(readAdminSession(config, token, issuedAt + ADMIN_SESSION_SECONDS * 1_000 + 1_000)).toBeUndefined();
    expect(readAdminSession(config, token, issuedAt - 120_000)).toBeUndefined();
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
  it("carries the account, client and scope", () => {
    const config = account();
    const { token } = createAiAccessToken(config, user(), "codex-client");
    expect(readAiAccessToken(config, token)).toMatchObject({
      id: "account-1",
      clientId: "codex-client",
      scopes: ["missiongo:read"],
    });
  });

  it("carries no product list at all", () => {
    // Which products the token reaches is the account's current permissions,
    // resolved on every request. Freezing them into a 30-day token is what would
    // let a revoked product stay readable for 30 days.
    const config = account();
    const { token } = createAiAccessToken(config, user(), "codex-client");
    expect(readAiAccessToken(config, token)).not.toHaveProperty("productIds");
    expect(Buffer.from(token.slice("mgai_".length).split(".")[0]!, "base64url").toString("utf8"))
      .not.toContain("productIds");
  });

  it("is issued to whoever authorized it, not to the deployment's first account", () => {
    const config = account();
    const { token } = createAiAccessToken(
      config,
      user({ id: "account-2", username: "member@example.com", role: "member" }),
      "codex-client",
    );
    expect(readAiAccessToken(config, token)).toMatchObject({ id: "account-2", role: "member" });
  });

  it("does not accept a session token, and the session reader does not accept it", () => {
    const config = account();
    const sessionToken = createAdminSession(config, user());
    const { token: aiToken } = createAiAccessToken(config, user(), "codex-client");

    expect(readAiAccessToken(config, sessionToken)).toBeUndefined();
    expect(readAdminSession(config, aiToken)).toBeUndefined();
  });

  it("rejects a tampered token or a foreign secret", () => {
    const config = account();
    const { token } = createAiAccessToken(config, user(), "codex-client");
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
    const { token, claims } = createAiAccessToken(config, user(), "codex-client", ["missiongo:read"], issuedAt);
    expect(readAiAccessToken(config, token, claims.expiresAt * 1_000 + 1_000)).toBeUndefined();
  });
});
