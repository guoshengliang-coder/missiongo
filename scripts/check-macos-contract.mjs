#!/usr/bin/env node
//
// Fail the build when the macOS client and the server disagree about which
// modes a dispatch may use, for each agent the client can start.
//
// Each list exists twice, in two languages: the server refuses a mode outside
// CLAUDE_CODE_MODES / CODEX_MODES / OPENCODE_MODES, and the client refuses to start a session in a mode outside
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
  ["OpenCode", "OPENCODE_MODES", "OpenCodeModes.swift"],
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

// The macOS update manifest lives at one fixed address, spelled out in four
// places that cannot import one another: the script that writes it, the two
// servers that serve it, and the Swift that fetches it. A typo in any one of
// them is a client that can never find an update, and nothing else fails.
const manifestSpellings = [
  ["scripts/publish-macos.sh", /UPDATE_MANIFEST="\$DOWNLOAD_DIRECTORY(\/[\w.-]+)"/],
  ["deploy/nginx-container.conf", /location = (\/downloads\/missiongo-macos-latest\.[\w.]+) \{\s*\n\s*default_type application\/json/],
  ["apps/web/vite.config.ts", /macosManifestPath = "([^"]+)"/],
  ["apps/macos/Sources/MissionGoNodeCore/AppUpdater.swift", /manifestPath = "([^"]+)"/],
];

const found = manifestSpellings.map(([file, pattern]) => {
  const match = pattern.exec(read(file));
  if (!match) {
    console.error(`Could not find the macOS update manifest path in ${file}.`);
    process.exit(1);
  }
  // publish-macos.sh names the file inside the downloads directory; the others
  // name the URL path it is served at.
  return [file, match[1].startsWith("/downloads/") ? match[1] : `/downloads${match[1]}`];
});

const [, expectedManifest] = found[0];
for (const [file, spelling] of found.slice(1)) {
  if (spelling !== expectedManifest) {
    console.error("The macOS update manifest is spelled differently in two places:");
    console.error(`  scripts/publish-macos.sh writes ${expectedManifest}`);
    console.error(`  ${file} uses ${spelling}`);
    failed = true;
  }
}
if (!failed) console.log(`macOS update manifest agrees everywhere: ${expectedManifest}`);

if (failed) process.exit(1);
