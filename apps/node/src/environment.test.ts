import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeEnvironmentCache, resolveClaudeLaunch } from "./environment.js";
import { ClaudeAdapter } from "./claude.js";
import { detectAgents } from "./runner.js";
import { probe } from "./process.js";
import { main } from "./cli.js";
import { loadConfig, saveConfig } from "./storage.js";

const directories: string[] = [];
const adapters: ClaudeAdapter[] = [];
const fixture = fileURLToPath(new URL("./fixtures/agent.cjs", import.meta.url));
const temporary = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "mg-env-"))); directories.push(root); return root; };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const script = (root: string, text: string, name = "env $(false) ' config.sh") => {
  const path = join(root, name); writeFileSync(path, text, { mode: 0o600 }); return path;
};
const base = (root: string) => ({ HOME: root, PATH: "/usr/bin:/bin", BASH_ENV: join(root, "must-not-run") });
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("explicit Claude environment", () => {
  it("loads only the chosen script, preserves multiline and empty values, and does not mutate the base", async () => {
    const root = temporary();
    writeFileSync(join(root, "must-not-run"), `touch ${quote(join(root, "unexpected"))}`);
    script(root, `touch ${quote(join(root, "profile-read"))}`, ".bashrc");
    const path = script(root, "export ANTHROPIC_AUTH_TOKEN='fixture=token\nsecond line'\nexport EMPTY=''\nunset OLD_KEY\necho fixture-secret\necho fixture-secret >&2\n");
    const inherited = { ...base(root), OLD_KEY: "old" };
    const result = await resolveClaudeLaunch({ environmentScript: path }, inherited);
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe("fixture=token\nsecond line");
    expect(result.env.EMPTY).toBe(""); expect(result.env.OLD_KEY).toBeUndefined();
    expect(inherited.OLD_KEY).toBe("old"); expect(existsSync(join(root, "unexpected"))).toBe(false);
    expect(existsSync(join(root, "profile-read"))).toBe(false);
    expect(result.env.BASH_ENV).toBe(inherited.BASH_ENV);
    expect(await resolveClaudeLaunch({}, inherited)).toEqual({ executable: "claude", env: inherited });
  });

  it("runs the same launcher and resolved environment for the version check and native conversation", async () => {
    const root = temporary(); const launcher = join(root, "my claude $(false)");
    chmodSync(fixture, 0o755);
    const path = script(root, `export PATH=${quote(`${dirname(process.execPath)}:/usr/bin:/bin`)}\nexport ANTHROPIC_AUTH_TOKEN=fixture-secret\n`);
    writeFileSync(launcher, `#!/bin/bash\n[ "$ANTHROPIC_AUTH_TOKEN" = fixture-secret ] || exit 42\nexec ${quote(fixture)} "$@"\n`, { mode: 0o700 });
    const launch = await resolveClaudeLaunch({ executable: launcher, environmentScript: path }, base(root));
    expect(await probe(launch.executable, ["--version"], root, launch.env)).toBe("codex-cli 1.0.0\n1.0.0 (Claude Code)");
    const adapter = new ClaudeAdapter({ dispatchId: "fixture", itemKeys: ["EX-1"], repoPath: root, agentKind: "claude_code", mode: "plan" }, launch.executable, launch.env);
    adapters.push(adapter);
    expect(await adapter.start("hello")).toMatch(/^[a-f0-9-]+$/);
    await delay(30);
    expect((await adapter.snapshot()).messages.some((message) => message.text === "hello")).toBe(true);
  });

  it("refreshes edited/removed values and never falls back when a new read fails", async () => {
    const root = temporary(); const path = script(root, "export CUSTOM_KEY=first\n");
    expect((await resolveClaudeLaunch({ environmentScript: path }, base(root))).env.CUSTOM_KEY).toBe("first");
    writeFileSync(path, "export CUSTOM_KEY=second\n");
    expect((await resolveClaudeLaunch({ environmentScript: path }, base(root))).env.CUSTOM_KEY).toBe("second");
    writeFileSync(path, "unset CUSTOM_KEY\n");
    expect((await resolveClaudeLaunch({ environmentScript: path }, base(root))).env.CUSTOM_KEY).toBeUndefined();
    writeFileSync(path, "echo fixture-secret >&2\nreturn 1\n");
    await expect(resolveClaudeLaunch({ environmentScript: path }, base(root))).rejects.toThrow("Agent environment script failed;");
    await expect(resolveClaudeLaunch({ environmentScript: path }, base(root))).rejects.not.toThrow("fixture-secret");
  });

  it("bounds timeout and descendant pipes and rejects scripts that replace the reader", async () => {
    const root = temporary(); const path = script(root, "sleep 10 & wait\n");
    const start = Date.now();
    await expect(resolveClaudeLaunch({ environmentScript: path }, base(root), 80)).rejects.toThrow("timed out");
    expect(Date.now() - start).toBeLessThan(1500);
    writeFileSync(path, "exec /usr/bin/true\n");
    await expect(resolveClaudeLaunch({ environmentScript: path }, base(root))).rejects.toThrow("script failed");
    await expect(resolveClaudeLaunch({ environmentScript: "relative.sh" }, base(root))).rejects.toThrow("absolute");
  });

  it("reuses heartbeat memory until an explicit recheck revision changes", async () => {
    const root = temporary(); vi.stubEnv("HOME", root);
    const count = join(root, "reads"); const path = script(root, `echo read >> ${quote(count)}\nexport TEST_VALUE=first\n`);
    const cache = new ClaudeEnvironmentCache(); const settings = { environmentScript: path, checkRevision: "one" };
    await cache.resolve(settings); await cache.resolve(settings);
    expect(readFileSync(count, "utf8")).toBe("read\n");
    writeFileSync(path, `echo read >> ${quote(count)}\nreturn 1\n`);
    await expect(cache.resolve({ ...settings, checkRevision: "two" })).rejects.toThrow("script failed");
    await expect(cache.resolve({ ...settings, checkRevision: "two" })).rejects.toThrow("script failed");
    expect(readFileSync(count, "utf8")).toBe("read\nread\n");
  });

  it("syncs Skill in the resolved Claude directory and does not inspect disabled agents", async () => {
    const root = temporary(); const configDir = join(root, "custom claude");
    const path = script(root, `export CLAUDE_CONFIG_DIR=${quote(configDir)}\n`);
    vi.stubEnv("HOME", root); chmodSync(fixture, 0o755);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("---\nversion: 1.0.0\n---\n"));
    const config = { installationId: "fixture", server: "https://missiongo.example.com", agents: { claude_code: { executable: fixture, environmentScript: path } } };
    expect((await detectAgents(config, "1.0.0"))[0]?.ready).toBe(true);
    expect(readFileSync(join(configDir, "skills/missiongo/SKILL.md"), "utf8")).toContain("version: 1.0.0");
    expect(existsSync(join(root, ".claude"))).toBe(false);
    await detectAgents({ ...config, agents: {} }); expect(fetch).toHaveBeenCalledOnce();
  });

  it("persists paths and recheck revision, preserves the launcher, and supports clearing", async () => {
    const root = temporary(); const state = join(root, "state"); vi.stubEnv("MISSIONGO_NODE_HOME", state); vi.stubEnv("HOME", root);
    const path = script(root, "export ANTHROPIC_AUTH_TOKEN=fixture-secret\n"); chmodSync(fixture, 0o755);
    saveConfig(state, { ...loadConfig(state), server: "https://missiongo.example.com", token: "fake-node", agents: { claude_code: { executable: fixture } } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("---\nversion: 1.0.0\n---\n"));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["agent", "enable", "claude_code", "--environment-script", path]);
    const initial = loadConfig(state).agents.claude_code!;
    expect(initial).toMatchObject({ executable: fixture, environmentScript: path });
    expect(readFileSync(join(state, "config.json"), "utf8")).not.toContain("fixture-secret");
    await main(["agent", "check"]);
    expect(loadConfig(state).agents.claude_code!.checkRevision).not.toBe(initial.checkRevision);
    vi.stubEnv("PATH", "/missing-fixture-bin");
    await main(["agent", "enable", "claude_code", "--clear-environment-script", "--clear-executable"]);
    expect(loadConfig(state).agents.claude_code).not.toHaveProperty("environmentScript");
    expect(loadConfig(state).agents.claude_code).not.toHaveProperty("executable");
    expect(JSON.stringify(output.mock.calls)).not.toContain("fixture-secret");
    await expect(main(["agent", "enable", "codex", "--environment-script", path])).rejects.toThrow("claude_code only");
  });

  it("diagnoses failed version checks with exit code or timeout, never raw stderr", async () => {
    const root = temporary(); const launcher = script(root, "#!/bin/bash\necho fixture-secret >&2\nexit 42\n", "launcher"); chmodSync(launcher, 0o700);
    await expect(probe(launcher, ["--version"])).rejects.toThrow("exit 42");
    await expect(probe(launcher, ["--version"])).rejects.not.toThrow("fixture-secret");
    writeFileSync(launcher, "#!/bin/bash\nexec sleep 10\n");
    await expect(probe(launcher, ["--version"], root, process.env, 80)).rejects.toThrow("timed out");
    await expect(probe(join(root, "missing"), ["--version"])).rejects.toThrow("not found");
  });
});

it("rejects Node itself as Codex before syncing any Skill", async () => {
  const root = temporary(); vi.stubEnv("HOME", root);
  const fetch = vi.spyOn(globalThis, "fetch");
  const [agent] = await detectAgents({ installationId: "fixture", server: "https://missiongo.example.com", agents: { codex: { executable: process.execPath } } });
  expect(agent).toMatchObject({ kind: "codex", ready: false });
  expect(agent?.unavailableReason).toContain("version output was not recognized");
  expect(fetch).not.toHaveBeenCalled(); expect(existsSync(join(root, ".codex"))).toBe(false);
});
it.each(["codex", "claude_code"] as const)("requires a working %s control handshake even when its version banner matches", async (kind) => {
  const root = temporary(); const launcher = script(root, '#!/bin/sh\nprintf "codex-cli 1.0.0\\n1.0.0 (Claude Code)\\n"\n', "wrong-agent"); chmodSync(launcher, 0o700);
  const fetch = vi.spyOn(globalThis, "fetch");
  const [agent] = await detectAgents({ installationId: "fixture", server: "https://missiongo.example.com", agents: { [kind]: { executable: launcher } } });
  expect(agent).toMatchObject({ kind, ready: false }); expect(fetch).not.toHaveBeenCalled();
});
it("rejects an actual OpenCode 1 server even if its registration advertises version 2", async () => {
  const root = temporary(); const registration = script(root, JSON.stringify({ version: "2.1.0", url: "https://opencode.example.com", password: "fixture-only" }), "service.json");
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ version: "1.9.0" }));
  const [agent] = await detectAgents({ installationId: "fixture", server: "https://missiongo.example.com", agents: { opencode: { serviceRegistration: registration } } });
  expect(agent).toMatchObject({ ready: false, unavailableReason: "OpenCode 2 is required" }); expect(fetch).toHaveBeenCalledOnce();
});
it.each(["codex", "claude_code"] as const)("keeps validated %s ready when only the model catalog is unavailable", async (kind) => {
  const root = temporary(); vi.stubEnv("HOME", root); chmodSync(fixture, 0o755);
  const path = script(root, "export TEST_CATALOG_FAILURE=1\n");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("---\nversion: 1.0.0\n---\n"));
  const [agent] = await detectAgents({ installationId: "fixture", server: "https://missiongo.example.com", agents: { [kind]: { executable: fixture, environmentScript: path } } });
  expect(agent).toMatchObject({ ready: true, models: [] });
});

it("reports current plan protocol and actual Claude mode evidence independently of launcher readiness", async () => {
  const root=temporary(); vi.stubEnv("HOME",root); chmodSync(fixture,0o755);
  const path=script(root,"export FAKE_CLAUDE_REJECT_MODE=auto\n");
  vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response("---\nversion: 1.0.0\n---\n"));
  const [agent]=await detectAgents({installationId:"fixture",server:"https://missiongo.example.com",agents:{claude_code:{executable:fixture,environmentScript:path,checkRevision:"mode-evidence"}}});
  expect(agent).toMatchObject({ready:true,planApprovalProtocol:1});
  expect(agent?.modes).toContainEqual({mode:"auto",state:"unavailable",reason:"native_mode_rejected"});
  expect(agent?.modes).toContainEqual({mode:"default",state:"available"});
});
