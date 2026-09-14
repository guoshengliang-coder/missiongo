import { describe, expect, it } from "vitest";
import { ANDROID_APK_DOWNLOAD_PATH, MACOS_CLIENT_DOWNLOAD_PATH, SKILL_DOWNLOAD_PATH, skillDownloadUrl } from "./downloads";

describe("downloads", () => {
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
