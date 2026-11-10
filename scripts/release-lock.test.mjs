import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const script = new URL("./release-lock.py", import.meta.url).pathname;
test("release lock rejects another process, permits nested scripts and releases on exit", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "missiongo-lock-"));
  const env = { ...process.env, XDG_CONFIG_HOME: directory };
  delete env.MISSIONGO_RELEASE_LOCK_FD;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const holder = spawn("python3", [script, "--", process.execPath, "-e", "console.log('locked'); setInterval(()=>{}, 1000)"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => holder.kill());
  await once(holder.stdout, "data");
  const busy = spawnSync("python3", [script, "--status"], { env, encoding: "utf8" });
  assert.equal(busy.status, 75); assert.match(busy.stderr, /already locked/);
  const stopped = once(holder, "exit"); holder.kill(); await stopped;
  assert.equal(spawnSync("python3", [script, "--status"], { env }).status, 0);
  const nested = spawnSync("python3", [script, "--", "sh", "-c", 'exec python3 "$1" -- echo nested', "sh", script], { env, encoding: "utf8" });
  assert.equal(nested.status, 0); assert.equal(nested.stdout.trim(), "nested");
});
