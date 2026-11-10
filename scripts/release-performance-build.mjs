import { execFileSync } from "node:child_process";

// Incremental build metadata does not authenticate ignored JS output. Rebuild
// every candidate source even when a stale/modified dist file has a newer mtime.
export function compilePerformanceCandidate(root) {
  execFileSync("npm", ["run", "build:types", "--", "--force"], { cwd: root, stdio: "ignore" });
}
