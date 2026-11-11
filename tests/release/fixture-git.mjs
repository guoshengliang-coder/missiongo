import { execFileSync } from "node:child_process";

// A fixture owns its repository, index, config and hooks. Never inherit Git's
// repository redirection or injected configuration from the invoking shell.
export const fixtureGit = (root, ...args) => execFileSync("git", args, {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
}).trim();
