import { expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, scryptSync } from "node:crypto";
import { buildApp } from "../../../services/server/src/app.js";
import { createAiAccessToken } from "../../../services/server/src/admin-auth.js";
import { main } from "./cli.js";
import { loadConfig, saveConfig } from "./storage.js";

it("configures repositories through the real server contract and preserves existing mappings", async () => {
  const directory = realpathSync(mkdtempSync("/tmp/mg-contract-"));
  const repository = join(directory, "repository"); mkdirSync(repository);
  execFileSync("git", ["init", repository], { stdio: "ignore" });
  const admin = { id: "test-owner", username: "fixture-owner", cookieSecure: true,
    passwordScrypt: `scrypt:${Buffer.from("missiongo-fixture-salt").toString("base64url")}:${scryptSync("fixture-password", Buffer.from("missiongo-fixture-salt"), 64).toString("base64url")}`,
    sessionSecret: "fixture-only-signing-secret-not-for-production" };
  const app = buildApp({ databasePath: join(directory, "test.sqlite"), attachmentsPath: join(directory, "attachments"), adminAccount: admin });
  try {
    const signedIn = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: admin.username, password: "fixture-password" } });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    const cookie = signedIn.headers["set-cookie"]!.split(";", 1)[0]!;
    const createProduct = async (name: string, keyPrefix: string) => {
      const response = await app.inject({ method: "POST", url: "/api/v1/products", headers: { cookie }, payload: { name, keyPrefix } });
      expect(response.statusCode).toBe(201); return response.json().id as string;
    };
    const first = await createProduct("Existing fixture", "FX");
    const second = await createProduct("New fixture", "NX");
    const stamp = app.missionGoAccounts.credentialsStamp(app.missionGoAccounts.getAccount(admin.id));
    const oauth = createAiAccessToken(admin, { id: admin.id, username: admin.username, role: "admin" }, stamp, "fixture-linux-node", ["missiongo:read", "missiongo:node"]).token;
    const registered = await app.inject({ method: "POST", url: "/api/v1/node/register", headers: { authorization: `Bearer ${oauth}` },
      payload: { installationId: randomUUID(), name: "Fixture Ubuntu", hostname: "fixture" } });
    expect(registered.statusCode).toBe(201);
    const node = registered.json(); const headers = { authorization: `Bearer ${node.token}` };
    const firstPath = "/work/existing-repository";
    expect((await app.inject({ method: "PUT", url: "/api/v1/node/repos", headers,
      payload: { repos: [{ productId: first, repoPath: firstPath }] } })).statusCode).toBe(200);
    const state = join(directory, "state"); vi.stubEnv("MISSIONGO_NODE_HOME", state);
    saveConfig(state, { ...loadConfig(state), server: "https://missiongo.example.com", token: node.token });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const result = await app.inject({ method: init?.method as "GET" | "PUT", url: url.pathname + url.search,
        headers: init?.headers as Record<string, string>, ...(init?.body ? { payload: JSON.parse(String(init.body)) } : {}) });
      return new Response(result.statusCode === 204 ? null : result.body, { status: result.statusCode, headers: { "Content-Type": "application/json" } });
    });
    await main(["repo", "set", second, repository]);
    const profile = (await app.inject({ method: "GET", url: "/api/v1/node/me", headers })).json();
    expect(profile.repos).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: first, repoPath: firstPath }),
      expect.objectContaining({ productId: second, repoPath: repository }),
    ]));
    await main(["repo", "remove", second]);
    expect((await app.inject({ method: "GET", url: "/api/v1/node/me", headers })).json().repos).toEqual([
      expect.objectContaining({ productId: first, repoPath: firstPath }),
    ]);
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
