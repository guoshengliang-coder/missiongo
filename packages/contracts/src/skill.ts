/**
 * The MissionGo Skill is distributed as a single public file so that every AI client
 * installs and updates it from one address. Because a stale local copy fails silently —
 * the client still reports a "complete" read while following an outdated workflow —
 * the server publishes the version it expects and the Skill compares it on every read.
 *
 * Bump MISSIONGO_SKILL_VERSION together with any change to skills/missiongo/SKILL.md
 * that alters AI behaviour. The contract guard in skill.test.ts enforces this.
 */
export const MISSIONGO_SKILL_VERSION = "3.0.0";

/** Public path of the published Skill, relative to MISSIONGO_PUBLIC_ORIGIN. */
export const MISSIONGO_SKILL_DOWNLOAD_PATH = "/downloads/missiongo-skill/SKILL.md";

/** Token replaced with the deployment origin when the Skill is published. */
export const MISSIONGO_SKILL_ORIGIN_PLACEHOLDER = "__MISSIONGO_PUBLIC_ORIGIN__";

export interface SkillVersionInfo {
  readonly expectedVersion: string;
  readonly updateUrl?: string;
}

/**
 * Describe the Skill version an AI client should be running. The update URL is only
 * available once a deployment origin is configured; on a loopback development server
 * there is no public address to hand out.
 */
export function skillVersionInfo(publicOrigin?: string): SkillVersionInfo {
  return {
    expectedVersion: MISSIONGO_SKILL_VERSION,
    ...(publicOrigin ? { updateUrl: `${publicOrigin}${MISSIONGO_SKILL_DOWNLOAD_PATH}` } : {}),
  };
}
