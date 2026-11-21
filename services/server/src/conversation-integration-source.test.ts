import { describe, expect, it } from "vitest";
import { assertIntegrationInstruction } from "./conversation-integration-source.js";

describe("conversation integration instruction rejection", () => {
  it.each([
    ["执行合并", "merge_only"], ["直接发布", "publish_only"], ["执行合并和发布", "merge_and_publish"],
    ["merge this PR", "merge_only"], ["deploy now", "publish_only"], ["merge and release", "merge_and_publish"],
    ["仅合并，不发布", "merge_only"], ["只发布，不合并", "publish_only"], ["only merge, do not publish", "merge_only"],
  ] as const)("accepts a bounded explicit command %s", (text, mode) => {
    expect(() => assertIntegrationInstruction(text, mode)).not.toThrow();
  });
  it.each(["先别合并", "不要发布", "是否合并", "能否发布", "为什么不能合并", "如果通过就发布", "以后发布", "添加到待集成", "建议合并", "合并方案", "文档写着“合并并发布”", "do not merge", "merge later", "publish?", "批准"])("rejects non-executing input %s", text => {
    expect(() => assertIntegrationInstruction(text, "merge_and_publish")).toThrow();
  });
  it("never silently broadens merge-only or publish-only", () => {
    expect(() => assertIntegrationInstruction("执行合并", "merge_and_publish")).toThrow(/不一致/);
    expect(() => assertIntegrationInstruction("执行发布", "merge_only")).toThrow(/不一致/);
  });
});
