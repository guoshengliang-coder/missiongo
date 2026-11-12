// Shared fixed inventory: installation and read-only readiness inspect the same files.
const TOOLS = [
  "release-readiness.mjs", "delivery-report.mjs", "release-tool-files.mjs", "release-lock.py", "release_coverage_options.py", "release-preflight.mjs", "release-receipt.mjs",
  "release-ci.mjs", "release-ci-wait.mjs", "linux-release-tools.mjs", "handover-evidence.mjs",
  "release-coverage.mjs", "release-candidates.mjs", "release-coverage-guard.sh", "release-status.sh", "release-timing.sh", "deploy.sh",
];
const ENTRY = "missiongo-release.py";
export const RELEASE_TOOL_FILES = { ...Object.fromEntries(TOOLS.map(name => [name, name])),
  // Install the implementation, not the repo-relative forwarding module.
  "handover-evidence.mjs": "../apps/web/public/downloads/missiongo-handover.mjs", entry: ENTRY };
