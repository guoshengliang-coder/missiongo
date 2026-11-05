import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skillPaths, skillVersion, syncSkill } from "./skills.js";

const source = readFileSync(fileURLToPath(new URL("../../../skills/missiongo/SKILL.md", import.meta.url)), "utf8");
const version = skillVersion(source)!;
const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const setup = () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mg-skill-upgrade-"))); roots.push(home);
  return { HOME: home, CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"), XDG_CONFIG_HOME: join(home, ".config") };
};
const seed = (path: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "---\nname: missiongo\nversion: 5.34.0\n---\nOld workflow\n"); };

it.each(["codex", "claude_code", "opencode"] as const)("upgrades existing %s targets from the public single-file Skill", async kind => {
  const env = setup();
  if (kind === "codex") seed(join(env.HOME, ".agents/skills/missiongo/SKILL.md"));
  const paths = skillPaths(kind, env); paths.forEach(seed);
  const fetch = vi.fn().mockResolvedValue(new Response(source)); vi.stubGlobal("fetch", fetch);
  expect(await syncSkill(kind, "https://missiongo.test", version, env)).toMatchObject({ localVersion: version, expectedVersion: version, syncState: "ready" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe("https://missiongo.test/downloads/missiongo-skill/SKILL.md");
  for (const path of paths) expect(readFileSync(path, "utf8")).toBe(source);
  fetch.mockClear();
  await syncSkill(kind, "https://missiongo.test", version, env);
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects a stale download and preserves the local Skill until versions agree", async () => {
  const env = setup(), path = skillPaths("codex", env)[0]!; seed(path);
  const before = readFileSync(path, "utf8");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(before)));
  await expect(syncSkill("codex", "https://missiongo.test", version, env)).rejects.toThrow("version could not be verified");
  expect(readFileSync(path, "utf8")).toBe(before);
});
