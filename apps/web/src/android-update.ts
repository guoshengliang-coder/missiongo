/**
 * The Android app's own update check (AND-258).
 *
 * The console runs inside the Android shell's WebView, so it is the console that
 * reads the published manifest and says what the new build contains; the shell
 * performs only the two steps a page cannot -- downloading the APK and handing it
 * to the system installer -- through the bridge in android-bridge.ts. Keeping the
 * check and the dialog here, rather than in the APK, means the wording and the
 * notes can change with a deploy instead of another APK release.
 *
 * The manifest is the Android twin of the one the macOS client reads
 * (apps/macos/.../AppUpdater.swift): a fixed address on the deployment the app is
 * already pointed at, compared numerically, and treated as untrusted JSON.
 * scripts/publish-android-internal.sh writes it; deploy/nginx-container.conf
 * serves it with a hard 404 when it is missing.
 */

import { ANDROID_APK_DOWNLOAD_PATH } from "./downloads";

export const ANDROID_UPDATE_MANIFEST_PATH = "/downloads/missiongo-android-latest.json";

export type AndroidReleaseItem = {
  key: string;
  title: string;
};

export type AndroidReleaseNote = {
  pullRequestNumber: number;
  title: string;
  items: AndroidReleaseItem[];
};

export type AndroidUpdateManifest = {
  version: string;
  /** Epoch seconds Gradle stamped into the APK; the only monotonic comparison. */
  versionCode: number;
  sha256: string;
  size: number;
  /** UTC `yyyyMMddHHmmss`, when the build was made. */
  buildTimestamp?: string;
  releaseNotes: AndroidReleaseNote[];
  /** Absolute path on this origin. Points at the product's own APK, never a host. */
  downloadPath: string;
};

/** A ceiling, not a size check -- the APK is ~320 KB. Keeps a bad manifest from promising gigabytes. */
const MAX_APK_BYTES = 200 * 1024 * 1024;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^[0-9]+(\.[0-9]+)*$/;
const ITEM_KEY_PATTERN = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseReleaseNotes(value: unknown): AndroidReleaseNote[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const notes: AndroidReleaseNote[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const { pullRequestNumber, title, items } = entry;
    if (typeof pullRequestNumber !== "number" || !Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) return undefined;
    if (typeof title !== "string" || !title.trim()) return undefined;
    if (!Array.isArray(items) || items.length > 50) return undefined;
    const parsedItems: AndroidReleaseItem[] = [];
    for (const item of items) {
      if (!isRecord(item)) return undefined;
      const { key, title: itemTitle } = item;
      if (typeof key !== "string" || !ITEM_KEY_PATTERN.test(key)) return undefined;
      if (typeof itemTitle !== "string" || !itemTitle.trim()) return undefined;
      parsedItems.push({ key, title: itemTitle.trim() });
    }
    notes.push({ pullRequestNumber, title: title.trim(), items: parsedItems });
  }
  return notes;
}

/**
 * The manifest as the app will use it, or undefined when anything is off. A
 * malformed body -- an HTML error page, a half-written file -- must read as "no
 * update", never as a reason to install something.
 */
export function parseAndroidUpdateManifest(raw: unknown): AndroidUpdateManifest | undefined {
  if (!isRecord(raw)) return undefined;
  const { version, versionCode, sha256, size, buildTimestamp, releaseNotes, downloadPath } = raw;
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) return undefined;
  if (typeof versionCode !== "number" || !Number.isInteger(versionCode) || versionCode <= 0) return undefined;
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) return undefined;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > MAX_APK_BYTES) return undefined;
  if (buildTimestamp !== undefined && (typeof buildTimestamp !== "string" || !/^[0-9]{14}$/.test(buildTimestamp))) return undefined;
  if (downloadPath !== ANDROID_APK_DOWNLOAD_PATH) return undefined;
  const parsedNotes = parseReleaseNotes(releaseNotes);
  if (!parsedNotes) return undefined;
  return {
    version,
    versionCode,
    sha256,
    size,
    ...(buildTimestamp === undefined ? {} : { buildTimestamp }),
    releaseNotes: parsedNotes,
    downloadPath,
  };
}

/** Whether the published build is newer than the one installed. Same code, or lower, is not an update. */
export function isNewerVersion(currentVersionCode: number, manifest: AndroidUpdateManifest): boolean {
  return manifest.versionCode > currentVersionCode;
}

/** The build time as a Date, or undefined when it is missing or not the expected shape. */
export function publishedAt(buildTimestamp: string | undefined): Date | undefined {
  if (!buildTimestamp) return undefined;
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(buildTimestamp);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
}

/** Reads the manifest, or undefined for any failure: offline, a 404, or a body that is not it. */
export async function fetchAndroidUpdateManifest(fetchImpl: typeof fetch = fetch): Promise<AndroidUpdateManifest | undefined> {
  try {
    const response = await fetchImpl(ANDROID_UPDATE_MANIFEST_PATH, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return undefined;
    return parseAndroidUpdateManifest(await response.json());
  } catch {
    return undefined;
  }
}

/**
 * The published build when it is newer than [currentVersionCode], else undefined.
 *
 * Silent by design: this runs on every cold start, and a check that could not be
 * made is not something to tell someone about. The macOS client reads its own
 * version from the bundle; here the shell reports it over the bridge, because
 * only the native side knows the versionCode Android actually compares.
 */
export async function checkAndroidUpdate({
  currentVersionCode,
  fetchImpl = fetch,
}: {
  currentVersionCode: number;
  fetchImpl?: typeof fetch;
}): Promise<AndroidUpdateManifest | undefined> {
  const manifest = await fetchAndroidUpdateManifest(fetchImpl);
  if (!manifest || !isNewerVersion(currentVersionCode, manifest)) return undefined;
  return manifest;
}
