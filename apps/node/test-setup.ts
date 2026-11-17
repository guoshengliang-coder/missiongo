import { afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOME alone does not isolate agents: an inherited CODEX_HOME takes precedence.
// Give every test private defaults, including Windows and provider config roots.
const homes: string[] = [];
beforeEach(() => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mg-node-test-home-"))); homes.push(home);
  for (const [key, value] of Object.entries({HOME:home,USERPROFILE:home,CODEX_HOME:join(home,".codex"),CLAUDE_CONFIG_DIR:join(home,".claude"),XDG_CONFIG_HOME:join(home,".config")})) vi.stubEnv(key,value);
});
afterAll(() => {
  vi.unstubAllEnvs();
  for (const home of homes) rmSync(home,{recursive:true,force:true});
});
