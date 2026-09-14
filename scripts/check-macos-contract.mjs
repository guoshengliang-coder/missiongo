#!/usr/bin/env node
//
// Fail the build when the macOS client and the server disagree about which
// modes a dispatch may use, for each agent the client can start.
//
// Each list exists twice, in two languages: the server refuses a mode outside
// CLAUDE_CODE_MODES / CODEX_MODES, and the client refuses to start a session in a mode outside
// its own copy before the mode reaches argv. If they drift, the console offers a
// mode that every Mac then rejects, or — worse — a mode is added to the client
// that the server never agreed to offer. Swift cannot import the TypeScript, so
// this compares the two sources directly.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");

const listIn = (source, pattern, label) => {
  const match = pattern.exec(source);
  if (!match) {
    console.error(`Could not find ${label}.`);
    process.exit(1);
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
};

// [label, TypeScript constant, Swift file declaring `allowed`]
const pairs = [
  ["Claude Code", "CLAUDE_CODE_MODES", "ClaudeCodeModes.swift"],
  ["Codex", "CODEX_MODES", "CodexModes.swift"],
];

const domain = read("packages/domain/src/dispatch.ts");
let failed = false;
for (const [agent, constant, swiftFile] of pairs) {
  const serverModes = listIn(
    domain,
    new RegExp(`${constant}\\s*=\\s*\\[([^\\]]*)\\]`),
    `${constant} in packages/domain/src/dispatch.ts`,
  );
  const clientModes = listIn(
    read(`apps/macos/Sources/MissionGoNodeCore/${swiftFile}`),
    /allowed[^=]*=\s*\[([^\]]*)\]/,
    `allowed in apps/macos/Sources/MissionGoNodeCore/${swiftFile}`,
  );
  if (serverModes.join(",") !== clientModes.join(",")) {
    console.error(`The macOS client and the server allow different ${agent} modes:`);
    console.error(`  server (packages/domain/src/dispatch.ts ${constant}): ${serverModes.join(", ")}`);
    console.error(`  client (apps/macos/.../${swiftFile}): ${clientModes.join(", ")}`);
    failed = true;
  } else {
    console.log(`macOS client and server agree on ${agent} modes: ${serverModes.join(", ")}`);
  }
}
if (failed) process.exit(1);
