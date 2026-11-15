import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { ReleaseObservations, repositoryIdentity } from "./release-observations.js";
import { loadConfig, saveConfig } from "./storage.js";
import { runNode } from "./runner.js";

const roots: string[] = [];
const temporary = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "mg-observation-"))); roots.push(root); return root; };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const observation = () => ({ schemaVersion: 2, id: randomUUID(), repository: "https://github.com/owner/repo", releases: [] });
function outbox(root: string, value = observation()) {
  const path = join(root, ".git", "missiongo-release-outbox"); mkdirSync(path, { recursive: true }); writeFileSync(join(path, `${value.id}.json`), JSON.stringify(value)); return value;
}
it("canonicalizes repository identities without credentials or traversal", () => {
  expect(repositoryIdentity("git@github.com:owner/repo.git")?.origin).toBe("https://github.com/owner/repo");
  expect(repositoryIdentity("https://secret@example.com/owner/repo")).toBeUndefined(); expect(repositoryIdentity("git@host:owner/../repo")).toBeUndefined();
});
it("uploads bound release facts once, backs off failures, and never changes item state", async () => {
  const root = temporary(); const value = outbox(root);
  const call = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ accepted: true, id: value.id });
  const worker = new ReleaseObservations(join(root, "node"), { server: "https://missiongo.example.com", call }, async (_file, args) => ({ code: 0, stdout: args[0] === "config" ? "git@github.com:owner/repo.git" : ".git" }));
  const repos = [{ productId: "fixture", repoPath: root }]; const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now);
  await worker.uploadObservations(repos); await worker.uploadObservations(repos); expect(call).toHaveBeenCalledOnce();
  vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
  await worker.uploadObservations(repos); await worker.uploadObservations(repos); expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls.every(([method, path]) => method === "POST" && path === "/api/v1/node/release-observations")).toBe(true);
  expect(call.mock.calls[1]?.[2]).toEqual({ productId: "fixture", repoPath: root, observation: value });
});
it("keeps uploading when the heartbeat explicitly disables retired status checks", async () => {
  const root = temporary(); const repo = join(root, "repo"); mkdirSync(repo);
  execFileSync("git", ["init", repo], { stdio: "ignore" }); execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:owner/repo.git"]);
  const value = outbox(repo); const state = join(root, "node");
  saveConfig(state, { ...loadConfig(state), server: "https://missiongo.example.com", token: "fixture-only", agents: {} });
  const controller = new AbortController(); const paths: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname; paths.push(path);
    if (path.endsWith("/heartbeat")) return Response.json({ repos: [{ productId: "fixture", repoPath: repo }], supportsStatusChecks: false });
    if (path.endsWith("/release-observations")) { controller.abort(); return Response.json({ accepted: true, id: value.id }); }
    if (path.endsWith("/managed-execution")) return Response.json({ jobs: [] });
    if (path.endsWith("/control-changes")) return Response.json({}, {status:404});
    if (path.endsWith("/agent-history")) return Response.json({jobs:[]});
    if (path.endsWith("/agent-artifacts")) return Response.json({ jobs: [] });
    if (path.endsWith("/agent-sessions")) return Response.json({ sessions: [] });
    throw new Error(`Unexpected endpoint ${path}`);
  });
  const timeout = setTimeout(() => controller.abort(), 4000);
  try { await runNode(state, "unused-entry", controller.signal, () => {}, undefined, { managedAllowed: true }); }
  finally { clearTimeout(timeout); }
  expect(paths).toContain("/api/v1/node/release-observations"); expect(paths.some((path) => /status-checks|completion-discovery/.test(path))).toBe(false);
});
