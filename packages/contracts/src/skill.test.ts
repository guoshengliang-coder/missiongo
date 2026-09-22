import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MCP_TOOL_DEFINITIONS } from "./mcp-tools.js";
import {
  MISSIONGO_SKILL_ORIGIN_PLACEHOLDER,
  MISSIONGO_SKILL_VERSION,
  skillVersionInfo,
} from "./skill.js";

const repositoryRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const skillPath = resolve(repositoryRoot, "skills/missiongo/SKILL.md");
const skill = readFileSync(skillPath, "utf8");

/**
 * SHA-256 of SKILL.md with its `version:` line removed. Any other edit to the Skill
 * changes this digest, which forces MISSIONGO_SKILL_VERSION to be bumped in the same
 * change. Without it a content change would keep both sides equal and the version
 * check would pass while deployed clients silently ran an outdated workflow.
 *
 * To update: bump MISSIONGO_SKILL_VERSION, run this test, and paste the actual digest.
 */
const SKILL_CONTENT_DIGEST = "ce2c42bd158db616889e94357bd29d181088ed691b8a0b4519d6166f42390fbf";

function skillBodyWithoutVersion(): string {
  return skill
    .split("\n")
    .filter((line) => !line.startsWith("version:"))
    .join("\n");
}

describe("MissionGo Skill contract", () => {
  it("declares the version the server expects", () => {
    const frontmatterVersion = /^version:\s*(\S+)\s*$/m.exec(skill)?.[1];
    expect(frontmatterVersion).toBe(MISSIONGO_SKILL_VERSION);
  });

  it("has not changed without a version bump", () => {
    const digest = createHash("sha256").update(skillBodyWithoutVersion(), "utf8").digest("hex");
    expect(
      digest,
      "skills/missiongo/SKILL.md changed. Bump MISSIONGO_SKILL_VERSION in skill.ts and update SKILL_CONTENT_DIGEST.",
    ).toBe(SKILL_CONTENT_DIGEST);
  });

  it("references only published MCP tools", () => {
    const published = new Set(MCP_TOOL_DEFINITIONS.map((tool) => tool.name));
    // Tool names are verb-prefixed, which keeps config keys such as `mcp_servers` out.
    const referenced = [...new Set(
      [...skill.matchAll(/`((?:get|list|claim|append|submit|create|update|delete)_[a-z_]+)`/g)]
        .map((match) => match[1]),
    )];

    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((name) => !published.has(name))).toEqual([]);
  });

  it("still drives the tools its read workflow depends on", () => {
    // Ordinary item reads use the named key. Release reconciliation has a narrow,
    // product-scoped candidate tool; neither path may lose its read dependencies.
    for (const name of ["get_current_account", "get_item_context", "get_item_timeline", "get_attachment"]) {
      expect(skill, `SKILL.md never mentions ${name}`).toContain(name);
      expect(MCP_TOOL_DEFINITIONS.map((tool) => tool.name)).toContain(name);
    }
    expect(skill).toContain("list_release_candidates");
  });

  it("keeps the deployment origin out of the tracked source", () => {
    expect(skill).toContain(MISSIONGO_SKILL_ORIGIN_PLACEHOLDER);
    expect(skill).not.toMatch(/https?:\/\//);
  });

  it("only offers an update URL once a deployment origin is known", () => {
    expect(skillVersionInfo()).toEqual({ expectedVersion: MISSIONGO_SKILL_VERSION });
    expect(skillVersionInfo("https://missiongo.test")).toEqual({
      expectedVersion: MISSIONGO_SKILL_VERSION,
      updateUrl: "https://missiongo.test/downloads/missiongo-skill/SKILL.md",
    });
  });
});
