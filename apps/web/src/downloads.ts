/**
 * Everything the console offers for download. All of it is served by this same
 * deployment under fixed "latest" names — nginx in production, vite.config.ts
 * in dev and preview — so the console never has to know which build is out.
 */
export { MACOS_CLIENT_DOWNLOAD_PATH } from "./node-install";

export const ANDROID_APK_DOWNLOAD_PATH = "/downloads/missiongo-android-latest.apk";

// Keep in sync with MISSIONGO_SKILL_DOWNLOAD_PATH in packages/contracts/src/skill.ts
export const SKILL_DOWNLOAD_PATH = "/downloads/missiongo-skill/SKILL.md";

/**
 * The address an AI client installs the Skill from. It has to be absolute: the
 * person pastes it into another program, where a path means nothing. The
 * console is served from the deployment's own origin, so that origin is the
 * public one.
 */
export function skillDownloadUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${SKILL_DOWNLOAD_PATH}`;
}
