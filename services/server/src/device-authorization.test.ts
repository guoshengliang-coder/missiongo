import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceAuthorizationStore, DEVICE_GRANT } from "./device-authorization.js";
import { MissionGoDatabase } from "./storage/database.js";
import { buildApp } from "./app.js";
import { readAiAccessToken } from "./admin-auth.js";

const origin = "https://missiongo.test";
const now = Date.parse("2026-09-30T00:00:00Z");
const user = { id: "owner", username: "owner@example.test", role: "admin" as const };
const salt = Buffer.from("device-login-test");
const account = { id: user.id, username: user.username,
  passwordScrypt: `scrypt:${salt.toString("base64url")}:${scryptSync("correct horse", salt, 64).toString("base64url")}`,
  sessionSecret: "device-test-secret-not-for-production", cookieSecure: true };
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const db = new MissionGoDatabase(":memory:");
  const store = new DeviceAuthorizationStore(db);
  return { db, store };
}

describe("durable device authorization", () => {
  it("commits pending and slow_down intervals without consuming another device", () => {
    const { db, store } = fixture();
    try {
      const a = store.begin("client", ["missiongo:read"], origin, now);
      const b = store.begin("client", ["missiongo:read"], origin, now);
      expect(a.user_code).not.toBe(b.user_code);
      expect(() => store.poll(a.device_code, "client", () => "token", now + 5000)).toThrow("authorization_pending");
      expect(() => store.poll(a.device_code, "client", () => "token", now + 6000)).toThrow("slow_down");
      expect(() => store.poll(a.device_code, "client", () => "token", now + 15_000)).toThrow("slow_down");
      expect(() => store.poll(b.device_code, "client", () => "token", now + 15_000)).toThrow("authorization_pending");
      const rows = db.connection.prepare("SELECT * FROM oauth_device_requests").all();
      expect(JSON.stringify(rows)).not.toContain(a.device_code);
      expect(JSON.stringify(rows)).not.toContain(a.user_code.replace("-", ""));
    } finally { db.close(); }
  });

  it("requires matching consent proof and client, and exchanges once", () => {
    const { db, store } = fixture();
    try {
      const grant = store.begin("client", ["missiongo:node"], origin, now);
      const request = store.verification(grant.user_code.toLowerCase(), now);
      expect(() => store.decide(grant.user_code, "forged", user, now, now)).toThrow("invalid_request");
      store.decide(grant.user_code, request.consent_proof, user, now, now);
      expect(() => store.poll(grant.device_code, "other-client", () => "token", now + 6000)).toThrow("invalid_grant");
      expect(store.poll(grant.device_code, "client", (row) => JSON.parse(row.user_json!).id, now + 6000)).toBe(user.id);
      expect(() => store.poll(grant.device_code, "client", () => "token", now + 12_000)).toThrow("invalid_grant");
      expect(() => store.decide(grant.user_code, request.consent_proof, user, now, now)).toThrow("invalid_request");
    } finally { db.close(); }
  });

  it("supports denial and expiration without issuing a token", () => {
    const { db, store } = fixture();
    try {
      const a = store.begin("client", [], origin, now);
      store.decide(a.user_code, store.verification(a.user_code, now).consent_proof, undefined, undefined, now);
      expect(() => store.poll(a.device_code, "client", () => "token", now + 6000)).toThrow("access_denied");
      const b = store.begin("client", [], origin, now);
      expect(() => store.verification(b.user_code, now + 600_000)).toThrow("invalid_request");
      expect(() => store.poll(b.device_code, "client", () => "token", now + 600_000)).toThrow("expired_token");
    } finally { db.close(); }
  });

  it("resumes an approved login after closing and reopening the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "device-login-"));
    const path = join(dir, "test.sqlite");
    let db = new MissionGoDatabase(path);
    try {
      const store = new DeviceAuthorizationStore(db);
      const grant = store.begin("client", [], origin, now);
      store.decide(grant.user_code, store.verification(grant.user_code, now).consent_proof, user, now, now);
      db.close();
      db = new MissionGoDatabase(path);
      expect(new DeviceAuthorizationStore(db).poll(grant.device_code, "client", () => "token", now + 6000)).toBe("token");
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });
});

describe("device login routes", () => {
  async function setup() {
    let clock = now;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const app = buildApp({ adminAccount: account, publicOrigin: origin, writeTools: "comments" });
    const registration = await app.inject({ method: "POST", url: "/oauth/register", payload: {
      client_name: "macOS device test", grant_types: [DEVICE_GRANT], token_endpoint_auth_method: "none",
    } });
    expect(registration.statusCode).toBe(201);
    const client = registration.json().client_id as string;
    const start = await app.inject({ method: "POST", url: "/oauth/device_authorization",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ client_id: client, scope: "missiongo:read missiongo:node" }).toString() });
    expect(start.statusCode).toBe(200);
    const grant = start.json();
    const poll = (overrides = {}) => app.inject({ method: "POST", url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ grant_type: DEVICE_GRANT, client_id: client, device_code: grant.device_code, ...overrides }).toString() });
    const page = await app.inject({ method: "GET", url: `/oauth/device?user_code=${grant.user_code}` });
    const proof = /name="proof" value="([^"]+)"/.exec(page.body)![1]!;
    const decide = (fields = {}) => app.inject({ method: "POST", url: "/oauth/device",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ user_code: grant.user_code, proof, username: account.username, password: "correct horse", ...fields }).toString() });
    return { app, client, grant, page, poll, decide, advance: () => { clock += 6000; } };
  }

  it("keeps a stable client and issues an audited node token without browser redirect", async () => {
    const { app, grant, page, poll, decide, advance } = await setup();
    try {
      expect(page.body).toContain(grant.user_code);
      expect(page.body).toContain("把这台 Mac 登记为你的设备");
      const metadata = (await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" })).json();
      expect(metadata.grant_types_supported).toContain("authorization_code");
      expect(metadata.device_authorization_endpoint).toBe(origin + "/oauth/device_authorization");
      advance(); expect((await poll()).json().error).toBe("authorization_pending");
      expect((await decide({ proof: "forged" })).statusCode).toBe(400);
      expect((await decide({ password: "wrong" })).statusCode).toBe(401);
      const approved = await decide();
      expect(approved.statusCode).toBe(200); expect(approved.headers.location).toBeUndefined();
      advance();
      const token = await poll(); expect(token.statusCode).toBe(200);
      expect(token.json().expires_in).toBe(15_552_000);
      expect(readAiAccessToken(account, token.json().access_token)).toMatchObject({ id: user.id, scopes: ["missiongo:read", "missiongo:node"] });
      const audit = app.missionGoAccounts.listAiAuthorizations(user.id);
      expect(audit).toHaveLength(1);
      expect((await poll()).json().error).toBe("invalid_grant");
    } finally { await app.close(); }
  });

  it("rejects a changed credential stamp between consent and exchange", async () => {
    const { app, decide, poll, advance } = await setup();
    try {
      expect((await decide()).statusCode).toBe(200);
      app.missionGoAccounts.changeOwnPassword(user.id, "correct horse", "a new correct horse");
      advance();
      expect((await poll()).json().error).toBe("access_denied");
      expect(app.missionGoAccounts.listAiAuthorizations(user.id)).toHaveLength(0);
    } finally { await app.close(); }
  });

  it("registers a stable device-only client and rejects invalid scopes and excessive starts", async () => {
    const { app, client } = await setup();
    try {
      const again = await app.inject({ method: "POST", url: "/oauth/register", payload: {
        client_name: "macOS device test", grant_types: [DEVICE_GRANT], token_endpoint_auth_method: "none",
      } });
      expect(again.json().client_id).toBe(client);
      expect(again.json().redirect_uris).toEqual([]);
      const legacy = await app.inject({ method: "POST", url: "/oauth/register", payload: {
        client_name: "Native MCP test", redirect_uris: ["http://127.0.0.1:1/callback"],
        grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none",
      } });
      expect(legacy.statusCode).toBe(201);
      expect(legacy.json().grant_types).toEqual(["authorization_code"]);
      const start = (scope = "missiongo:read") => app.inject({ method: "POST", url: "/oauth/device_authorization",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ client_id: client, scope }).toString() });
      expect((await start("missiongo:admin")).json().error).toBe("invalid_scope");
      for (let i = 0; i < 28; i++) expect((await start()).statusCode).toBe(200);
      expect((await start()).statusCode).toBe(429);
      const unauthorized = await app.inject({ method: "GET", url: `/oauth/authorize?client_id=${encodeURIComponent(client)}&redirect_uri=http://127.0.0.1:1/callback&response_type=code&code_challenge=${"x".repeat(43)}&code_challenge_method=S256` });
      expect(unauthorized.statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it("rejects consent denial and rate limits short-code guesses", async () => {
    const { app, decide, poll, advance } = await setup();
    try {
      expect((await decide({ decision: "deny", password: "" })).statusCode).toBe(200);
      advance(); expect((await poll()).json().error).toBe("access_denied");
      for (let i = 0; i < 10; i++) await app.inject({ method: "GET", url: "/oauth/device?user_code=WRONG" });
      expect((await app.inject({ method: "GET", url: "/oauth/device?user_code=WRONG" })).statusCode).toBe(429);
    } finally { await app.close(); }
  });
});
