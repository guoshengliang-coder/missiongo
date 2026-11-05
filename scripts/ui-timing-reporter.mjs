import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// Keep only repo-relative locations and numeric/status data; never copy test
// output, browser attachments, fixture data or environment values into timing data.
export default class UITimingReporter {
  constructor(options = {}) { this.directory = options.directory ?? "ci-timings"; this.tests = []; }
  onBegin(_config, suite) { this.expectedTests = suite.allTests().length; }
  onTestEnd(test, result) {
    const file = relative(process.cwd(), test.location.file).split("\\").join("/");
    if (isAbsolute(file) || file.startsWith("../")) throw new Error("Timing test must be inside checkout");
    this.tests.push({ id: test.id, file, durationMs: result.duration, status: result.status, expectedStatus: test.expectedStatus, retry: result.retry });
  }
  onEnd(result) {
    const kind = process.env.UI_TIMING_KIND ?? "audit", shard = Number(process.env.UI_SHARD ?? 1);
    if (!["audit", "visual"].includes(kind) || !Number.isInteger(shard) || shard < 1 || shard > 8) throw new Error("Invalid timing shard");
    let plan;
    try { plan = JSON.parse(process.env.UI_TEST_PLAN ?? "null"); } catch { /* standalone local run */ }
    const data = { version: 1, head: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? null, kind, shard, mode: plan?.mode ?? "standalone",
      status: result.status, durationMs: result.duration, expectedTests: this.expectedTests, tests: this.tests };
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(resolve(this.directory, `ui-${kind}-${shard}.json`), JSON.stringify(data) + "\n");
  }
  printsToStdio() { return false; }
}
