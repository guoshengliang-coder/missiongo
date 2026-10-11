import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

import plugin, { sessionContext } from "../apps/web/public/downloads/missiongo-agent-integration/opencode-session.mjs";

test("Claude SessionStart publishes only the native identity and never hook secrets or transcript paths", () => {
  const run = (input) => spawnSync(process.execPath, [new URL("../apps/web/public/downloads/missiongo-agent-integration/claude-session.cjs", import.meta.url).pathname], { input: JSON.stringify(input), encoding: "utf8" });
  const result = run({ hook_event_name: "SessionStart", session_id: "12345678-1234-1234-1234-123456789abc", transcript_path: "synthetic-private-path", model: "private-model", token: "synthetic-secret" });
  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /12345678-1234-1234-1234-123456789abc/);
  assert.match(context, /"autoConnect":true/);
  for (const value of ["synthetic-private-path", "private-model", "synthetic-secret"]) assert.ok(!context.includes(value));
  for (const input of [{ hook_event_name: "PreToolUse", session_id: "12345678-1234-1234-1234-123456789abc" }, { hook_event_name: "SessionStart", session_id: "untrusted/path" }]) assert.equal(run(input).stdout, "");
});

test("OpenCode V2 uses each current session callback independently and releases its registration", async () => {
  let handler, disposed = false;
  const stop = await plugin.setup({ session: { async hook(name, callback) {
    assert.equal(name, "context"); handler = callback;
    return { async dispose() { disposed = true; } };
  } } });
  const first = { sessionID: "ses_first", system: [], options: { model: "original" } };
  const second = { sessionID: "ses_second", system: [], options: { model: "third-party" } };
  handler(first); handler(second);
  assert.match(first.system[0].text, /ses_first/);
  assert.ok(!first.system[0].text.includes("ses_second"));
  assert.match(second.system[0].text, /ses_second/);
  assert.deepEqual(second.options, { model: "third-party" });
  assert.equal(sessionContext("unexpected/path"), undefined);
  await stop(); assert.equal(disposed, true);
});

test("one-time setup preserves third-party settings and unrelated hooks and is idempotent", async () => {
  const { mkdtemp, readFile, rm, readdir, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { install } = await import("../apps/web/public/downloads/missiongo-agent-integration/install.mjs");
  const root = await mkdtemp(join(tmpdir(), "missiongo-integration-"));
  try {
    const claudeDirectory = join(root, "claude"), opencodeDirectory = join(root, "opencode");
    await mkdir(claudeDirectory);
    const original = { env: { ANTHROPIC_BASE_URL: "https://synthetic.example", ANTHROPIC_AUTH_TOKEN: "synthetic-private-token" }, model: "company-alias", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "existing-hook" }] }], Stop: [] } };
    await writeFile(join(claudeDirectory, "settings.json"), JSON.stringify(original));
    const options = { claudeDirectory, opencodeDirectory, assets: { claude: "// identity hook", opencode: "export default {}" }, nodePath: "node's path" };
    await install(options);
    const configured = JSON.parse(await readFile(join(claudeDirectory, "settings.json"), "utf8"));
    assert.deepEqual(configured.env, original.env); assert.equal(configured.model, original.model);
    assert.deepEqual(configured.hooks.SessionStart[0], original.hooks.SessionStart[0]);
    assert.equal(configured.hooks.SessionStart.length, 2);
    assert.match(configured.hooks.SessionStart[1].hooks[0].command, /node'\\''s path/);
    const before = await readdir(claudeDirectory);
    await install(options);
    assert.deepEqual(await readdir(claudeDirectory), before);
    assert.equal(JSON.parse(await readFile(join(opencodeDirectory, "plugins", "missiongo-session", "package.json"), "utf8")).type, "module");
    const bad = "{ invalid-json"; await writeFile(join(claudeDirectory, "settings.json"), bad);
    await assert.rejects(install({ ...options, assets: { claude: "changed", opencode: "changed" } }));
    assert.equal(await readFile(join(claudeDirectory, "settings.json"), "utf8"), bad);
    assert.equal(await readFile(join(claudeDirectory, "missiongo-session.cjs"), "utf8"), options.assets.claude);
  } finally { await rm(root, { recursive: true, force: true }); }
});
