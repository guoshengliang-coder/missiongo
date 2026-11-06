#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isReleaseMetadata } from "./check-release-metadata.mjs";

import { platforms, pathPlatforms } from "./ci-platform-impact.mjs";
import { validBaseline } from "./ci-main-baseline.mjs";

export function selectPlatforms({ head, eventName, changes, releaseMetadataValidated = false, baseline = null, productImpact = null }) {
  const full = reason => ({ version: 2, head, eventName, baseline, required: Object.fromEntries(platforms.map(name => [name, true])), reasons: [reason] });
  if (eventName !== "pull_request" && !(eventName === "push" && validBaseline(baseline, head))) return full("No verified full-main baseline; require every platform");
  if (!changes?.length) return full("Missing change evidence");
  const required = Object.fromEntries(platforms.map(name => [name, false])), reasons = [];
  for (const { path, status } of changes) {
    if (typeof path !== "string" || path.startsWith("/") || path.split("/").includes("..") || path.includes("\\")
      || path.split("/").some(part => !part || part === ".") || !["A", "M", "D"].includes(status)) return full("Unknown path or unsupported change type");
    if (isReleaseMetadata(path) && releaseMetadataValidated) { reasons.push(`Validated publication facts: ${path}`); continue; }
    const impact = path === "product.json" && status === "M" ? productImpact : pathPlatforms(path);
    if (!Array.isArray(impact) || impact.some(name => !platforms.includes(name))) return full(`Shared or unknown platform input: ${path}`);
    for (const platform of impact) required[platform] = true;
    reasons.push(`${path}: ${impact.length ? impact.join(", ") : "no native build"}`);
  }
  return { version: 2, head, eventName, baseline, required, reasons };
}

export function assertPlatformResult({ plan, platform, head, eventName, planResult, buildResult }) {
  if (!platforms.includes(platform) || plan?.version !== 2 || plan.eventName !== eventName || !/^[0-9a-f]{40}$/.test(plan.head ?? "") || plan.head !== head
    || !plan.required || Object.keys(plan.required).sort().join() !== [...platforms].sort().join()
    || platforms.some(name => typeof plan.required[name] !== "boolean")) throw new Error("Invalid or stale platform plan");
  if (planResult !== "success") throw new Error("Platform planning must succeed");
  if (eventName !== "pull_request" && platforms.some(name => !plan.required[name])
    && !(eventName === "push" && validBaseline(plan.baseline, head))) throw new Error("Narrow main plan requires a verified full-build baseline");
  const expected = plan.required[platform] ? "success" : "skipped";
  if (buildResult !== expected) throw new Error(`${platform} build must be ${expected}, found ${buildResult}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assertPlatformResult({ plan: JSON.parse(process.env.CI_PLATFORM_PLAN ?? "null"), platform: process.argv[2], head,
    eventName: process.env.GITHUB_EVENT_NAME, planResult: process.env.CI_PLAN_RESULT, buildResult: process.env.CI_BUILD_RESULT });
}
