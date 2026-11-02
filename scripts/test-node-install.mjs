#!/usr/bin/env node
// Real npm installation on the two supported Ubuntu runners, entirely inside
// a temporary prefix/home. No service is enabled on a developer's machine.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Run this install check on supported Linux x86_64");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "missiongo-npm-install-"));
const product = JSON.parse(readFileSync(join(root, "product.json"), "utf8"));
try {
  execFileSync(process.execPath, ["scripts/build-node.mjs"], { cwd: root, stdio: "inherit" });
  const env = { ...process.env, HOME: scratch, MISSIONGO_NODE_HOME: join(scratch, "state"), XDG_CONFIG_HOME: join(scratch, "config"), npm_config_cache: join(scratch, "cache") };
  const packed = JSON.parse(execFileSync("npm", ["pack", join(root, "apps/node/dist/package"), "--json", "--ignore-scripts", "--pack-destination", scratch], { cwd: root, env, encoding: "utf8" }));
  execFileSync("npm", ["install", "--global", "--offline", "--ignore-scripts", "--prefix", join(scratch, "prefix"), join(scratch, packed[0].filename)], { env, stdio: "inherit" });
  const entry = join(scratch, "prefix/bin", product.linuxNode.command);
  assert.equal(execFileSync(entry, ["--version"], { env, encoding: "utf8" }).trim(), product.linuxNode.version);
  assert.match(execFileSync(entry, ["--help"], { env, encoding: "utf8" }), /systemd/);
  execFileSync(entry, ["service", "install"], { env, stdio: "inherit" });
  const unit = join(env.XDG_CONFIG_HOME, "systemd/user/missiongo-node.service");
  execFileSync("systemd-analyze", ["verify", unit], { env, stdio: "inherit" });
  execFileSync(entry, ["service", "uninstall"], { env, stdio: "inherit" });
  console.log("Linux npm install, executable, and systemd unit syntax passed (no service started).");
} finally { rmSync(scratch, { recursive: true, force: true }); }
