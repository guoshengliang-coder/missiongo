import { expect, it } from "vitest";
import { isAbsolute, sep } from "node:path";
import { skillPaths } from "./skills.js";

const inheritedHome=process.env.HOME;
const inheritedCodexHome=process.env.CODEX_HOME;
it("keeps every default Agent Skill target inside the test's private home despite inherited configuration",()=>{
  const home=process.env.HOME!;
  expect(home).not.toBe(inheritedHome);expect(isAbsolute(home)).toBe(true);
  expect(process.env.CODEX_HOME).not.toBe(inheritedCodexHome);
  expect(process.env.USERPROFILE).toBe(home);
  for(const kind of ["codex","claude_code","opencode"] as const) {
    for(const path of skillPaths(kind)) expect(path.startsWith(home+sep)).toBe(true);
  }
});
