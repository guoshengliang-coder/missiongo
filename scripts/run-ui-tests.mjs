#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertUIResults, currentHead, validatePlan } from "./ui-test-plan.mjs";

export function playwrightArguments(value, kind, shard = 1) {
  validatePlan(value);
  if (kind === "audit") {
    if (!["full", "targeted"].includes(value.mode) || !value.shards.includes(shard)) throw new Error("Audit is not selected for this shard");
    const files = value.mode === "full" ? value.shardFiles[shard - 1] : value.auditFiles;
    // The plan already allocated complete files; Playwright must not shard
    // that subset again or it would silently omit part of the coverage.
    return ["test", "--project=audit", "--shard=1/1",
      ...files.map(file => file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$")];
  }
  if (kind !== "visual" || !value.visual) throw new Error("Visual tests are not selected");
  return ["test", "--project=visual", ...(value.mode === "snapshots" ? ["--update-snapshots=all"] : [])];
}

function main() {
  const { values } = parseArgs({ options: { kind: { type: "string" }, shard: { type: "string", default: "1" }, list: { type: "boolean", default: false } } });
  const value = validatePlan(JSON.parse(process.env.UI_TEST_PLAN ?? "null"), { head: currentHead() });
  if (values.kind === "check") {
    assertUIResults({ value, planResult: process.env.UI_PLAN_RESULT, auditResult: process.env.UI_AUDIT_RESULT,
      visualResult: process.env.UI_VISUAL_RESULT, eventName: process.env.GITHUB_EVENT_NAME, snapshotUpdate: process.env.UI_UPDATE_SNAPSHOTS === "true" });
  } else {
    const args = playwrightArguments(value, values.kind, Number(values.shard));
    if (values.list) args.push("--list");
    const result = spawnSync(process.execPath, [resolve("node_modules/@playwright/test/cli.js"), ...args], { stdio: "inherit" });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
