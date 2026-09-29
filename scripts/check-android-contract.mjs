#!/usr/bin/env node
//
// Fail the build when the Android self-update manifest is spelled differently in
// two places (AND-258).
//
// The manifest lives at one fixed address, spelled out in four files that cannot
// import one another: the publish script that writes it, the nginx location that
// serves it publicly, the dev server that answers it locally, and the page that
// fetches it inside the app's WebView. A typo in any one of them is an app that
// can never find an update, and nothing else fails -- the same failure the macOS
// manifest check in scripts/check-macos-contract.mjs exists for.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");

// [file, pattern capturing how that file names the manifest]
const spellings = [
  ["scripts/publish-android-internal.sh", /UPDATE_MANIFEST="\$DOWNLOAD_DIRECTORY(\/[\w.-]+)"/],
  ["deploy/nginx-container.conf", /location = (\/downloads\/missiongo-android-latest\.[\w.]+) \{\s*\n\s*default_type application\/json/],
  ["apps/web/vite.config.ts", /androidManifestPath = "([^"]+)"/],
  ["apps/web/src/android-update.ts", /ANDROID_UPDATE_MANIFEST_PATH = "([^"]+)"/],
];

const found = spellings.map(([file, pattern]) => {
  const match = pattern.exec(read(file));
  if (!match) {
    console.error(`Could not find the Android update manifest path in ${file}.`);
    process.exit(1);
  }
  // publish-android-internal.sh names the file inside the downloads directory;
  // the others name the URL path it is served at.
  return [file, match[1].startsWith("/downloads/") ? match[1] : `/downloads${match[1]}`];
});

let failed = false;
const [, expectedManifest] = found[0];
for (const [file, spelling] of found.slice(1)) {
  if (spelling !== expectedManifest) {
    console.error("The Android update manifest is spelled differently in two places:");
    console.error(`  scripts/publish-android-internal.sh writes ${expectedManifest}`);
    console.error(`  ${file} uses ${spelling}`);
    failed = true;
  }
}
if (!failed) console.log(`Android update manifest agrees everywhere: ${expectedManifest}`);

if (failed) process.exit(1);
