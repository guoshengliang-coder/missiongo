import { describe, expect, it, vi } from "vitest";

import {
  ANDROID_UPDATE_MANIFEST_PATH,
  checkAndroidUpdate,
  fetchAndroidUpdateManifest,
  isNewerVersion,
  parseAndroidUpdateManifest,
  publishedAt,
} from "./android-update";
import { ANDROID_APK_DOWNLOAD_PATH } from "./downloads";

const manifest = {
  version: "0.1.17",
  versionCode: 1_759_100_000,
  sha256: "a".repeat(64),
  size: 327_680,
  buildTimestamp: "20260929120000",
  releaseNotes: [
    {
      pullRequestNumber: 210,
      title: "AND-258 Android self-update",
      items: [{ key: "AND-258", title: "安卓客户端增加检查更新与下载安装功能" }],
    },
  ],
  downloadPath: ANDROID_APK_DOWNLOAD_PATH,
};

/** A fetch stub that answers with one body and status. */
function respond(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("android update manifest", () => {
  it("accepts the shape publish-android-internal.sh writes", () => {
    expect(parseAndroidUpdateManifest(manifest)).toEqual(manifest);
  });

  it("keeps the manifest path in sync with what the shell and nginx serve", () => {
    expect(ANDROID_UPDATE_MANIFEST_PATH).toBe("/downloads/missiongo-android-latest.json");
  });

  it("refuses a manifest that would install something else", () => {
    expect(parseAndroidUpdateManifest({ ...manifest, downloadPath: "https://evil.invalid/x.apk" })).toBeUndefined();
    expect(parseAndroidUpdateManifest({ ...manifest, downloadPath: "//evil.invalid/x.apk" })).toBeUndefined();
    expect(parseAndroidUpdateManifest({ ...manifest, sha256: "not-a-digest" })).toBeUndefined();
    expect(parseAndroidUpdateManifest({ ...manifest, versionCode: 0 })).toBeUndefined();
    expect(parseAndroidUpdateManifest({ ...manifest, version: "latest" })).toBeUndefined();
    expect(parseAndroidUpdateManifest({ ...manifest, size: 0 })).toBeUndefined();
    expect(parseAndroidUpdateManifest({ ...manifest, releaseNotes: [{ pullRequestNumber: 1, title: "x", items: [{ key: "nope", title: "y" }] }] })).toBeUndefined();
    expect(parseAndroidUpdateManifest("<!doctype html>")).toBeUndefined();
    expect(parseAndroidUpdateManifest(null)).toBeUndefined();
  });

  it("treats a missing release-notes array as no notes", () => {
    const { releaseNotes, ...withoutNotes } = manifest;
    expect(releaseNotes).toBeDefined();
    expect(parseAndroidUpdateManifest(withoutNotes)?.releaseNotes).toEqual([]);
  });

  it("only counts a strictly newer versionCode as an update", () => {
    const parsed = parseAndroidUpdateManifest(manifest)!;
    expect(isNewerVersion(parsed.versionCode - 1, parsed)).toBe(true);
    expect(isNewerVersion(parsed.versionCode, parsed)).toBe(false);
    expect(isNewerVersion(parsed.versionCode + 1, parsed)).toBe(false);
  });

  it("reads the build time as UTC", () => {
    expect(publishedAt("20260929120000")?.toISOString()).toBe("2026-09-29T12:00:00.000Z");
    expect(publishedAt(undefined)).toBeUndefined();
    expect(publishedAt("2026-09-29")).toBeUndefined();
  });
});

describe("android update check", () => {
  it("returns the manifest only when it is newer", async () => {
    const found = await checkAndroidUpdate({ currentVersionCode: manifest.versionCode - 1, fetchImpl: respond(manifest) });
    expect(found?.version).toBe("0.1.17");
    expect(await checkAndroidUpdate({ currentVersionCode: manifest.versionCode, fetchImpl: respond(manifest) })).toBeUndefined();
  });

  it("stays silent for a 404, an HTML body, or a failed fetch", async () => {
    expect(await fetchAndroidUpdateManifest(respond("not found", 404))).toBeUndefined();
    expect(await fetchAndroidUpdateManifest(respond("<!doctype html><html></html>"))).toBeUndefined();
    const offline = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await fetchAndroidUpdateManifest(offline)).toBeUndefined();
  });
});
