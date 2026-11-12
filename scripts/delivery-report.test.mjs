import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeliveryReport, reportMarkdown } from "./delivery-report.mjs";
const now = Date.parse("2026-01-01T00:00:00Z"), head = "a".repeat(40), merge = "b".repeat(40);
const local = { version: 1, target: "test host", files: [{ name: "release-tool.py", beforeSha256: "d".repeat(64), afterSha256: "c".repeat(64), sizeBytes: 42 }],
  validation: { checks: [{ name: "Bytes", result: "passed", method: "Compare SHA-256", evidence: "Match" }], remainingVerification: ["Real batch not exercised"], limitations: ["This host only"] } };
const localVerification = { target: "test host", checkedAt: new Date(now).toISOString(), files: [{ name: "release-tool.py", sha256: "c".repeat(64) }], entryCheck: { result: "passed", method: "Actual installed status entry", evidence: "Status returned expected source" } };
const operations = { now, resolveIntegration: () => ({ state: "merged", mergeCommit: merge }), ancestor: () => true };
function fixture() {
  return { schemaVersion: 1, productId: "product", repository: "https://github.com/example/project", head, scope: ["AND-1:event", "AND-2:local"],
    receipt: { schemaVersion: 1, deployedCommit: head, current: { web: { version: "1.0.1", commit: head, clean: true, ciPassed: true } }, publicEvidence: { checks: { web: true } } },
    items: [{ identity: "AND-1:event", productId: "product", requiredArtifacts: ["web", "macosApp"], completion: { kind: "github", url: "https://github.com/example/project/pull/1" }, itemStatus: "pending_verification" },
      { identity: "AND-2:local", productId: "product", requiredArtifacts: [], noReleaseReason: "Local tool only", completion: { kind: "local_change", evidence: structuredClone(local) }, localVerification: structuredClone(localVerification), itemStatus: "pending_verification" }] };
}
test("mixed publication and local effects remain separate, with gaps and responsible next steps", () => {
  const input = fixture(), report = buildDeliveryReport(input, operations), [web, tool] = report.items;
  assert.equal(web.publication, "部分产物已发布"); assert.deepEqual(web.publishedArtifacts, ["web"]);
  assert.ok(web.gaps.some(gap => gap.includes("macosApp"))); assert.ok(web.nextOwner.some(owner => owner.includes("发布执行者")));
  assert.equal(tool.publication, "无需产品发布"); assert.equal(tool.localEffect, "本机已生效（执行端核实）");
  assert.ok(tool.gaps.includes("This host only")); assert.ok(tool.nextOwner.some(owner => owner.includes("人工验收人")));
  assert.ok(reportMarkdown(report).includes("AND-2:local")); assert.equal(input.items[0].itemStatus, "pending_verification");
});
test("partial evidence, a finished item or a manual status never fabricate full publication", () => {
  const input = fixture(); input.items[0].itemStatus = "done"; delete input.receipt;
  assert.equal(buildDeliveryReport(input, operations).items[0].publication, "发布待核实");
  const wrong = fixture(); wrong.receipt.current.web.commit = merge;
  assert.equal(buildDeliveryReport(wrong, operations).items[0].publication, "发布待核实");
  const unmerged = buildDeliveryReport(fixture(), { ...operations, resolveIntegration: () => ({ state: "unmerged" }) });
  assert.equal(unmerged.items[0].publication, "发布待核实");
});
test("all required artifacts must have provenance including the integration", () => {
  const input = fixture(); input.receipt.current.macosApp = { version: "2", sourceCommit: head }; input.receipt.publicEvidence.checks.macosApp = true;
  assert.equal(buildDeliveryReport(input, operations).items[0].publication, "已完整发布");
  assert.equal(buildDeliveryReport(input, { ...operations, ancestor: (older, newer) => newer !== head }).items[0].merged, false);
});
test("a verified old artifact without the integration stays missing", () => {
  const input = fixture(); input.receipt.current.macosApp = { version: "old", sourceCommit: "f".repeat(40) }; input.receipt.publicEvidence.checks.macosApp = true;
  const report = buildDeliveryReport(input, { ...operations, ancestor: (_older, newer) => newer !== "f".repeat(40) });
  assert.equal(report.items[0].publication, "部分产物已发布");
  assert.deepEqual(report.items[0].publishedArtifacts, ["web"]);
});
test("generic checks, wrong bytes, old or failed actual-entry evidence never establish local effect", () => {
  for (const mutate of [item => delete item.localVerification, item => item.localVerification.files[0].sha256 = "d".repeat(64),
    item => item.localVerification.entryCheck.result = "failed", item => item.localVerification.checkedAt = "2025-01-01T00:00:00Z",
    item => item.localVerification.target = "other host", item => item.completion.evidence.validation.checks[0].result = "not_run",
    item => item.localVerification.files.push(item.localVerification.files[0]), item => delete item.localVerification.entryCheck.method]) {
    const input = fixture(); mutate(input.items[1]);
    assert.equal(buildDeliveryReport(input, operations).items[1].localEffect, "本机生效待核实");
  }
});
test("every scoped delivery is reported once; exclusions need reasons and remain visible", () => {
  for (const mutate of [input => input.items.pop(), input => input.items.push(input.items[0]), input => input.scope.push("missing"),
    input => input.items[0].productId = "other", input => input.items[0].included = false]) {
    const input = fixture(); mutate(input); assert.throws(() => buildDeliveryReport(input, operations));
  }
  const input = fixture(); input.items[0].included = false; input.items[0].exclusionReason = "User deferred current delivery";
  const report = buildDeliveryReport(input, operations); assert.equal(report.items[0].included, false);
  assert.ok(report.items[0].gaps.some(gap => gap.includes("代码仍可能")));
});
test("Markdown renders input as text rather than allowing table/HTML injection", () => {
  const input = fixture(); input.items[1].noReleaseReason = "<script> | new\nrow";
  const markdown = reportMarkdown(buildDeliveryReport(input, operations));
  assert.ok(markdown.includes("&lt;script&gt; \\| new row")); assert.ok(!markdown.includes("<script>"));
});

test("human cancellation or hold keeps its own meaning without suggesting automatic continuation", () => {
  for (const status of ["cancelled", "on_hold"]) {
    const input = fixture(); input.items[0].itemStatus = status;
    const result = buildDeliveryReport(input, operations).items[0];
    assert.equal(result.verification, status);
    assert.deepEqual(result.nextOwner, ["用户：保留暂停或取消决定；恢复需明确授权"]);
    assert.equal(input.items[0].itemStatus, status);
  }
});
