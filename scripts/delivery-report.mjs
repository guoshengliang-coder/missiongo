#!/usr/bin/env node
// Read-only reporting of an explicit scope. Caller must supply original domain evidence.
// No item mutation, shell commands from input, implicit file reads or acceptance decisions.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { integrationFacts, commitContains, receiptArtifacts } from "./release-coverage.mjs";
import { repositoryIdentity } from "./handover-evidence.mjs";

const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/;
const text = value => typeof value === "string" && value.trim().length > 0 && value.length <= 4000;
const recent = (value, now) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 60_000 && now - Date.parse(value) <= 15 * 60_000;
const resource = value => text(value) && !value.startsWith("/") && !value.includes("\\") && !value.includes(":") && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && value.split("/").every(p => p && p !== "." && p !== ".." && !p.startsWith("~"));
const strings = value => Array.isArray(value) ? value.filter(text) : [];
const safe = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");

/** Explicit target/byte and actual-entry attestation, never generic "tests passed". */
export function localEffect(evidence, verification, now) {
  if (!evidence || evidence.version !== 1 || !text(evidence.target) || !Array.isArray(evidence.files) || !evidence.files.length || evidence.files.length > 32
    || new Set(evidence.files.map(file => file.name)).size !== evidence.files.length || evidence.files.some(file => !resource(file.name)
    || !(file.afterSha256 === null || DIGEST.test(file.afterSha256 ?? "")) || !(file.beforeSha256 === null || DIGEST.test(file.beforeSha256 ?? ""))
    || file.beforeSha256 === file.afterSha256 || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.afterSha256 === null && file.sizeBytes !== 0)) return false;
  if (!verification || verification.target !== evidence.target || !recent(verification.checkedAt, now)
    || !Array.isArray(verification.files) || verification.files.length !== evidence.files.length
    || new Set(verification.files.map(f => f.name)).size !== verification.files.length
    || !evidence.files.every(file => verification.files.some(actual => actual.name === file.name && actual.sha256 === file.afterSha256))) return false;
  const entry = verification.entryCheck;
  return entry?.result === "passed" && text(entry.method) && text(entry.evidence)
    && Array.isArray(evidence.validation?.checks) && evidence.validation.checks.length > 0 && evidence.validation.checks.length <= 32
    && evidence.validation.checks.every(check => check.result === "passed" && text(check.method) && text(check.evidence));
}

export function buildDeliveryReport(input, { resolveIntegration, ancestor, now = Date.now() }) {
  if (input?.schemaVersion !== 1 || !text(input.productId) || !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(input.repository ?? "") || !SHA.test(input.head ?? "")
    || !Array.isArray(input.scope) || !input.scope.length || input.scope.length > 5000 || new Set(input.scope).size !== input.scope.length || input.scope.some(id => !text(id))
    || !Array.isArray(input.items) || input.items.length !== input.scope.length || new Set(input.items.map(row => row.identity)).size !== input.items.length
    || input.items.some(row => !input.scope.includes(row.identity))) throw new Error("Report requires a complete explicit scope with every delivery exactly once");
  const publicArtifacts = input.receipt?.schemaVersion === 1 ? receiptArtifacts(input.receipt) : [];
  const items = input.scope.map(identity => {
    const item = input.items.find(row => row.identity === identity);
    if (item.productId !== input.productId || item.included === false && !text(item.exclusionReason)) throw new Error("Report product differs or exclusion has no reason");
    const required = item.requiredArtifacts;
    if (required !== null && (!Array.isArray(required) || new Set(required).size !== required.length || required.some(a => !/^[a-z][A-Za-z0-9_-]{0,49}$/.test(a)))) throw new Error("Invalid report artifact scope");
    const gaps = [], evidence = [], owners = [];
    let merged = false, mergeCommit;
    const local = item.completion?.kind === "local_change" ? item.completion.evidence : undefined;
    if (!local) {
      try {
        const facts = resolveIntegration(item);
        if (facts.state === "merged" && SHA.test(facts.mergeCommit ?? "") && ancestor(facts.mergeCommit, input.head)) {
          merged = true; mergeCommit = facts.mergeCommit; evidence.push(`集成提交 ${mergeCommit}`);
        } else gaps.push("尚未核实代码已纳入目标主线");
      } catch { gaps.push("集成证据待核实"); }
      if (!merged) owners.push("集成执行者：核实PR及目标分支");
    }
    const noRelease = Array.isArray(required) && required.length === 0 && text(item.noReleaseReason);
    let publication = "待核实", applied = false;
    const publishedArtifacts = [];
    if (noRelease) {
      publication = "无需产品发布"; evidence.push(item.noReleaseReason);
      if (local) {
        applied = localEffect(local, item.localVerification, now);
        if (applied) {
          evidence.push(`执行端核实 ${local.target} · ${item.localVerification.checkedAt}`, item.localVerification.entryCheck.evidence);
        } else { gaps.push("本机生效待核实：缺少当前目标摘要或实际入口成功检查"); owners.push("本机工具维护者：核实文件与实际入口"); }
        gaps.push(...strings(local.validation?.remainingVerification), ...strings(local.validation?.limitations));
        for (const check of local.validation?.checks ?? []) if (check.result !== "passed") gaps.push(`${check.name}：${check.result}`);
      }
    } else if (Array.isArray(required) && required.length) {
      const receiptBound = input.receipt?.schemaVersion === 1 && SHA.test(input.receipt?.deployedCommit ?? "")
        && input.receipt.current?.web?.commit === input.receipt.deployedCommit && input.receipt.publicEvidence?.checks?.web === true;
      if (merged && receiptBound) for (const artifact of required) {
        const proof = publicArtifacts.find(a => a.artifact === artifact && text(a.version) && SHA.test(a.sourceCommit ?? ""));
        try { if (proof && ancestor(mergeCommit, proof.sourceCommit)) { publishedArtifacts.push(artifact); evidence.push(`${artifact} ${proof.version} · ${proof.sourceCommit}`); } } catch { /* Missing objects stay unknown. */ }
      }
      publication = publishedArtifacts.length === required.length ? "已完整发布" : publishedArtifacts.length ? "部分产物已发布" : "发布待核实";
      const missing = required.filter(artifact => !publishedArtifacts.includes(artifact));
      if (missing.length) { gaps.push(`未核实产物：${missing.join("、")}`); owners.push("发布执行者：补齐并核实全部必需产物"); }
    } else { gaps.push("发布范围未知或缺少无需发布原因"); owners.push("产品操作者与执行者：核实发布范围"); }
    if (item.included === false) { gaps.unshift(`未包含：${item.exclusionReason}；已合并代码仍可能随产物上线`); owners.push("用户与执行者：确认后续安排"); }
    // Human item status and handover are shown as records, never inferred from publication.
    const verification = ["inbox", "ready", "in_progress", "development_complete", "on_hold", "pending_verification", "done", "cancelled"].includes(item.itemStatus) ? item.itemStatus : "unknown";
    if (verification === "pending_verification") owners.push("人工验收人：验证并决定验收结果");
    else if (["on_hold", "cancelled"].includes(verification)) { owners.length = 0; owners.push("用户：保留暂停或取消决定；恢复需明确授权"); }
    else if (verification !== "done") owners.push("执行者：核实交接；人工验收人决定验收结果");
    gaps.push(...strings(item.remainingVerification));
    return { identity, included: item.included !== false, integration: local ? "不适用（本机变更）" : merged ? "代码已合并" : "代码集成未核实", merged, mergeCommit: mergeCommit ?? null, publication, localEffect: local ? applied ? "本机已生效（执行端核实）" : "本机生效待核实" : "未提供本机安装证据",
      requiredArtifacts: required, publishedArtifacts, verification, evidence, gaps: [...new Set(gaps)], nextOwner: [...new Set(owners)],
      notification: "未核实通知送达" };
  });
  return { schemaVersion: 1, kind: "delivery_report", productId: input.productId, repository: input.repository, head: input.head, receiptDigest: input.receipt ? createHash("sha256").update(JSON.stringify(input.receipt)).digest("hex") : null, checkedAt: new Date(now).toISOString(), items,
    boundary: "只读核对调用方提供的原始证据；本机效果为执行端的限定环境核实，不是脚本重新安装或执行检查；人工状态、通知送达与发布独立；不推进业务状态" };
}

export function reportMarkdown(report) {
  return ["逐项交付结果（证据截至 " + safe(report.checkedAt) + "）", "", "| 对象 | 结果 | 证据与验证缺口 | 下一步责任 |", "|---|---|---|---|", ...report.items.map(item =>
    `| ${safe(item.identity)} | ${safe([item.included ? "纳入" : "未包含", item.integration, item.publication, item.localEffect, "人工状态记录：" + item.verification].join("；"))} | ${safe([...item.evidence, ...item.gaps, item.notification].join("；") || "暂无证据")} | ${safe(item.nextOwner.join("；") || "人工验收人：保留既有决定")} |`), "", report.boundary].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = process.argv.slice(2), values = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!["--root", "--input", "--format"].includes(args[i]) || values[args[i]] !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Use report --input <complete evidence JSON> [--format json|markdown]");
      values[args[i]] = args[i + 1];
    }
    if (!values["--input"] || values["--format"] && !["json", "markdown"].includes(values["--format"])) throw new Error("Invalid report input/format");
    const root = resolve(values["--root"] ?? process.cwd()), input = JSON.parse(readFileSync(values["--input"], "utf8"));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 }).trim();
    if (input.head !== git("rev-parse", "HEAD") || input.head !== git("rev-parse", "origin/main")
      || input.head !== git("ls-remote", "origin", "refs/heads/main").split(/\s/)[0]
      || input.repository.toLowerCase() !== repositoryIdentity(git("config", "--get", "remote.origin.url")).toLowerCase()) throw new Error("Report checkout differs from live main; refresh exact repository and head");
    const report = buildDeliveryReport(input, { resolveIntegration: item => integrationFacts(item, input.repository, root), ancestor: (a, b) => commitContains(root, a, b) });
    console.log(values["--format"] === "markdown" ? reportMarkdown(report) : JSON.stringify(report, null, 2));
  } catch (error) { console.error(`Delivery report failed: ${error.message}`); process.exitCode = 1; }
}
