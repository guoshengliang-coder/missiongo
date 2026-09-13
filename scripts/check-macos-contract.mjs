#!/usr/bin/env node
//
// Fail the build when the macOS client and the server disagree about which
// Claude Code modes a dispatch may use.
//
// The list exists twice, in two languages: the server refuses a mode outside
// CLAUDE_CODE_MODES, and the client refuses to start a session in a mode outside
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

const serverModes = listIn(
  read("packages/domain/src/dispatch.ts"),
  /CLAUDE_CODE_MODES\s*=\s*\[([^\]]*)\]/,
  "CLAUDE_CODE_MODES in packages/domain/src/dispatch.ts",
);
const clientModes = listIn(
  read("apps/macos/Sources/MissionGoNodeCore/ClaudeCodeModes.swift"),
  /allowed[^=]*=\s*\[([^\]]*)\]/,
  "ClaudeCodeModes.allowed in apps/macos/Sources/MissionGoNodeCore/ClaudeCodeModes.swift",
);

if (serverModes.join(",") !== clientModes.join(",")) {
  console.error("The macOS client and the server allow different Claude Code modes:");
  console.error(`  server (packages/domain/src/dispatch.ts): ${serverModes.join(", ")}`);
  console.error(`  client (apps/macos/.../ClaudeCodeModes.swift): ${clientModes.join(", ")}`);
  process.exit(1);
}
console.log(`macOS client and server agree on Claude Code modes: ${serverModes.join(", ")}`);
