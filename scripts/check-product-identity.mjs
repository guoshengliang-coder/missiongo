#!/usr/bin/env node
//
// Fail the build when MissionGo's product identity drifts.
//
// The name, the icon, the Android package names and the version name each used
// to be hardcoded in several files at once, so they diverged silently: the
// official app shipped under the SDK sample's package ID, the sample called
// itself "MissionGo" with the product's icon, and the Android version name
// existed only as a literal inside a publish script. product.json is now the
// single declaration; this asserts every copy still agrees with it.
//
// The icon comparison is deliberate about its limits: it checks that the web
// SVG and the Android vectors declare the same colours, and that the Android
// vectors share their path geometry with each other. It does not re-render the
// artwork, so it catches recolouring and a half-finished edit, not a redrawn
// path that keeps the palette.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");
const product = JSON.parse(read("product.json"));

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

// A comment explaining which colour something must NOT be still contains that
// colour, so strip comments before reading any value out of a file.
const stripComments = (source) => source.replace(/<!--[\s\S]*?-->/g, "");
const coloursOf = (source) =>
  new Set((stripComments(source).match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((c) => c.toUpperCase()));
const pathsOf = (source) =>
  (stripComments(source).match(/(?:pathData|\sd)="([^"]+)"/g) ?? []).map((m) => m.trim());
const sameSet = (a, b) => a.size === b.size && [...a].every((value) => b.has(value));

const gradleApplicationId = (relativePath) =>
  read(relativePath).match(/applicationId\s*=\s*"([^"]+)"/)?.[1];
const androidString = (relativePath, name) =>
  read(relativePath).match(new RegExp(`<string name="${name}">([^<]*)</string>`))?.[1];

// --- Names ---------------------------------------------------------------
const app = product.android.app;
const sample = product.android.feedbackSample;

check(
  androidString(`${app.path}/src/main/res/values/strings.xml`, "app_name") === app.label,
  `${app.path} app_name must be "${app.label}" (product.json android.app.label)`,
);
check(
  androidString(`${sample.path}/src/main/res/values/strings.xml`, "app_name") === sample.label,
  `${sample.path} app_name must be "${sample.label}" (product.json android.feedbackSample.label)`,
);
check(
  sample.label !== product.name,
  "the SDK sample must not use the product name as its launcher label",
);

for (const target of [app, sample]) {
  check(
    /android:label="@string\/app_name"/.test(read(`${target.path}/src/main/AndroidManifest.xml`)),
    `${target.path} must take android:label from @string/app_name, not a literal`,
  );
}

const manifest = JSON.parse(read("apps/web/public/manifest.webmanifest"));
check(manifest.name === product.name, `web manifest name must be "${product.name}"`);
check(manifest.short_name === product.name, `web manifest short_name must be "${product.name}"`);
check(read("apps/web/index.html").includes(`<title>${product.name}`), `index.html title must start with "${product.name}"`);

// --- Package names -------------------------------------------------------
check(
  gradleApplicationId(`${app.path}/build.gradle.kts`) === app.applicationId,
  `${app.path} applicationId must be ${app.applicationId}`,
);
check(
  gradleApplicationId(`${sample.path}/build.gradle.kts`) === sample.applicationId,
  `${sample.path} applicationId must be ${sample.applicationId}`,
);
check(
  app.applicationId !== sample.applicationId,
  "the app and the SDK sample must not share an applicationId: they would overwrite each other on a device",
);

// --- Version name --------------------------------------------------------
const [versionFile, versionKey] = product.versionNameSource.split("#");
const versionName = read(versionFile).match(new RegExp(`^${versionKey}=(.+)$`, "m"))?.[1]?.trim();
check(/^\d+(\.\d+)*$/.test(versionName ?? ""), `${versionFile} must declare ${versionKey} as a version number`);
check(
  !/versionName\s*=\s*"/.test(read(`${app.path}/build.gradle.kts`)),
  `${app.path}/build.gradle.kts must take versionName from ${versionKey}, not a literal`,
);
check(
  !/VERSION_NAME=["']?\d/.test(read("scripts/publish-android-internal.sh")),
  `scripts/publish-android-internal.sh must read the version name from ${versionFile}, not a literal`,
);

// --- Icon ----------------------------------------------------------------
const webIconColours = coloursOf(read(product.icon));

// Android draws the icon twice: an adaptive foreground over a background
// colour, and a flat pre-v26 fallback. A half-finished recolour touches one and
// leaves the other, so require every app's two copies to agree before comparing
// any of them with the web icon.
const iconOf = (path) => {
  const launcher = read(`${path}/src/main/res/mipmap-anydpi/ic_launcher.xml`);
  const foreground = read(`${path}/src/main/res/drawable/ic_launcher_foreground.xml`);
  const background = read(`${path}/src/main/res/values/colors.xml`);
  return {
    launcherColours: coloursOf(launcher),
    adaptiveColours: new Set([...coloursOf(foreground), ...coloursOf(background)]),
    launcherPaths: pathsOf(launcher),
    foregroundPaths: pathsOf(foreground),
  };
};

for (const target of [app, sample]) {
  const icon = iconOf(target.path);
  check(
    sameSet(icon.launcherColours, icon.adaptiveColours),
    `${target.path} adaptive icon and its pre-v26 fallback must use the same colours`,
  );
  check(
    icon.foregroundPaths.every((path) => icon.launcherPaths.includes(path)),
    `${target.path} adaptive foreground and launcher icon must draw the same shapes`,
  );
}

check(
  sameSet(iconOf(app.path).launcherColours, webIconColours),
  `${app.path} icon colours must match ${product.icon}`,
);
check(
  !sameSet(iconOf(sample.path).launcherColours, webIconColours),
  "the SDK sample icon must be visibly different from the product icon",
);

// --- Report --------------------------------------------------------------
if (failures.length > 0) {
  console.error(`Product identity does not match product.json:\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`\nUpdate the file that drifted, or product.json if the product really changed.`);
  process.exit(1);
}
console.log(`Product identity matches product.json: ${product.name}, ${app.applicationId}, ${versionName}`);
