import { existsSync, lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Kind } from "./types.js";

export function skillPaths(kind: Kind, env = process.env): string[] {
  const home = env.HOME ?? homedir();
  if (kind === "claude_code") return [join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "skills/missiongo/SKILL.md")];
  if (kind === "opencode") return [join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode/skills/missiongo/SKILL.md")];
  const paths = [join(env.CODEX_HOME ?? join(home, ".codex"), "skills/missiongo/SKILL.md")];
  const shared = join(home, ".agents/skills/missiongo/SKILL.md");
  if (existsSync(shared)) paths.push(shared);
  return paths;
}
export function skillVersion(text: string): string | undefined { return /^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m.exec(text)?.[1]; }
function compare(a: string, b: string): number {
  const aa = a.split(".").map(Number); const bb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
  return 0;
}
export async function syncSkill(kind: Kind, server: string, expected?: string): Promise<{ localVersion?: string; expectedVersion?: string; syncState: string; checkedAt: string }> {
  const paths = skillPaths(kind);
  let downloaded: string | undefined;
  for (const path of paths) {
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const current = skillVersion(existing);
    if (expected && current === expected) continue;
    // Parent symlinks must not be used to silently overwrite someone else's skill.
    let link = path;
    while (link !== dirname(link)) { if (existsSync(link) && lstatSync(link).isSymbolicLink()) throw new Error("MissionGo Skill path is a symlink; update it manually"); link = dirname(link); }
    if (expected && current && compare(current, expected) > 0) throw new Error("Local Skill is newer than the server; it was preserved");
    if (downloaded === undefined) {
      const response = await fetch(`${server}/downloads/missiongo-skill/SKILL.md`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("Skill download failed");
      downloaded = await response.text();
      if (downloaded.length > 200_000 || !skillVersion(downloaded) || (expected && skillVersion(downloaded) !== expected)) throw new Error("Skill version could not be verified");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`; writeFileSync(temp, downloaded, { mode: 0o600, flag: "wx" }); renameSync(temp, path);
  }
  const localVersion = skillVersion(readFileSync(paths[0]!, "utf8"));
  return { ...(localVersion ? { localVersion } : {}), ...(expected ? { expectedVersion: expected } : {}), syncState: "ready", checkedAt: new Date().toISOString() };
}
