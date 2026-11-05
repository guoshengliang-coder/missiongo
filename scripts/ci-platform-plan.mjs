#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isReleaseMetadata } from "./check-release-metadata.mjs";

const platforms = ["android", "macos", "linuxNode"];

export function selectPlatforms({ head, eventName, changes, releaseMetadataValidated = false }) {
  const full = reason => ({ version: 1, head, required: Object.fromEntries(platforms.map(name => [name, true])), reasons: [reason] });
  if (eventName !== "pull_request") return full("Main and manual runs require every platform");
  if (!changes?.length) return full("Missing change evidence");
  const required = Object.fromEntries(platforms.map(name => [name, false]));
  for (const { path, status } of changes) {
    if (typeof path !== "string" || path.startsWith("/") || path.split("/").includes("..") || path.includes("\\")
      || !["A", "M"].includes(status)) return full("Unknown path or destructive change");
    if (isReleaseMetadata(path) && releaseMetadataValidated) continue;
    if (/^(docs\/.*\.md|[^/]+\.md)$/.test(path) || path.startsWith("tests/ui/") || path.startsWith("apps/web/")) continue;
    if (path.startsWith("apps/macos/")) required.macos = true;
    else if (path.startsWith("apps/android/") || path.startsWith("sdks/android-feedback/")) required.android = true;
    else if (path.startsWith("apps/node/")) required.linuxNode = true;
    else return full(`Shared or unknown platform input: ${path}`);
  }
  return { version: 1, head, required, reasons: ["Native checks selected from PR file dependencies; Web/contract checks always run"] };
}

export function assertPlatformResult({ plan, platform, head, eventName, planResult, buildResult }) {
  if (!platforms.includes(platform) || plan?.version !== 1 || !/^[0-9a-f]{40}$/.test(plan.head ?? "") || plan.head !== head
    || !plan.required || Object.keys(plan.required).sort().join() !== [...platforms].sort().join()
    || platforms.some(name => typeof plan.required[name] !== "boolean")) throw new Error("Invalid or stale platform plan");
  if (planResult !== "success") throw new Error("Platform planning must succeed");
  if (eventName !== "pull_request" && platforms.some(name => !plan.required[name])) throw new Error("Main and manual runs require every platform");
  const expected = plan.required[platform] ? "success" : "skipped";
  if (buildResult !== expected) throw new Error(`${platform} build must be ${expected}, found ${buildResult}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assertPlatformResult({ plan: JSON.parse(process.env.CI_PLATFORM_PLAN ?? "null"), platform: process.argv[2], head,
    eventName: process.env.GITHUB_EVENT_NAME, planResult: process.env.CI_PLAN_RESULT, buildResult: process.env.CI_BUILD_RESULT });
}
