import { describe, expect, it } from "vitest";
import { ANDROID_APK_DOWNLOAD_PATH, MACOS_CLIENT_DOWNLOAD_PATH, SKILL_DOWNLOAD_PATH, skillDownloadUrl, windowsDownload } from "./downloads";

describe("downloads", () => {
  it("offers only a published signed Windows installer and never an arbitrary URL", () => {
    const manifest = { signed: true, version: "0.1.0", platform: "win32", arch: "x64", sha256: "a".repeat(64), filename: "missiongo-windows-0.1.0-x64-setup.exe" };
    expect(windowsDownload(manifest)).toBe("/downloads/windows/missiongo-windows-0.1.0-x64-setup.exe");
    expect(windowsDownload({ ...manifest, signed: false })).toBeUndefined();
    expect(windowsDownload({ ...manifest, filename: "https://foreign.example.com/setup.exe" })).toBeUndefined();
    expect(windowsDownload({ ...manifest, filename: "../setup.exe" })).toBeUndefined();
  });
  it("points at the fixed names nginx and vite serve", () => {
    expect(ANDROID_APK_DOWNLOAD_PATH).toBe("/downloads/missiongo-android-latest.apk");
    expect(MACOS_CLIENT_DOWNLOAD_PATH).toBe("/downloads/missiongo-macos-latest.zip");
    expect(SKILL_DOWNLOAD_PATH).toBe("/downloads/missiongo-skill/SKILL.md");
  });

  it("builds an absolute Skill address from the page origin", () => {
    expect(skillDownloadUrl("https://missiongo.example.com")).toBe("https://missiongo.example.com/downloads/missiongo-skill/SKILL.md");
    expect(skillDownloadUrl("http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/downloads/missiongo-skill/SKILL.md");
  });
});
