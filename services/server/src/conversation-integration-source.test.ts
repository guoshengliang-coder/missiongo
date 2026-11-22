import { describe, expect, it } from "vitest";
import { assertIntegrationInstruction } from "./conversation-integration-source.js";

describe("conversation integration instruction rejection", () => {
  it.each([
    ["继续合并", "merge_only"], ["继续发布", "publish_only"], ["继续部署", "publish_only"],
    ["继续合并和发布", "merge_and_publish"], ["继续执行合并和发布", "merge_and_publish"],
    ["请继续合并和发布", "merge_and_publish"],
    ["执行合并", "merge_only"], ["直接发布", "publish_only"], ["执行合并和发布", "merge_and_publish"],
    ["merge this PR", "merge_only"], ["deploy now", "publish_only"], ["merge and release", "merge_and_publish"],
    ["仅合并，不发布", "merge_only"], ["只发布，不合并", "publish_only"], ["only merge, do not publish", "merge_only"],
  ] as const)("accepts a bounded explicit command %s", (text, mode) => {
    expect(() => assertIntegrationInstruction(text, mode)).not.toThrow();
  });
  it.each(["先别合并", "不要发布", "是否合并", "能否发布", "为什么不能合并", "如果通过就发布", "以后发布", "添加到待集成", "建议合并", "合并方案", "文档写着“合并并发布”", "do not merge", "merge later", "publish?", "批准"])("rejects non-executing input %s", text => {
    expect(() => assertIntegrationInstruction(text, "merge_and_publish")).toThrow();
  });
  it.each([
    ["继续", "merge_only"], ["继续执行", "merge_only"],
    ["继续先别合并", "merge_only"], ["继续合并吗", "merge_only"],
    ["继续发布么", "publish_only"], ["如果通过就继续发布", "publish_only"],
    ["明天继续合并", "merge_only"], ["引用：继续合并", "merge_only"],
    ["文档里写着继续发布", "publish_only"], ["“继续合并和发布”", "merge_and_publish"],
    ["继续合并和发布完成", "merge_and_publish"], ["已经合并和发布", "merge_and_publish"],
    ["继续添加到待集成", "merge_and_publish"],
  ] as const)("rejects non-executing continuation %s", (text, mode) => {
    expect(() => assertIntegrationInstruction(text, mode)).toThrow();
  });
  it("never silently broadens merge-only or publish-only", () => {
    expect(() => assertIntegrationInstruction("执行合并", "merge_and_publish")).toThrow(/不一致/);
    expect(() => assertIntegrationInstruction("执行发布", "merge_only")).toThrow(/不一致/);
    expect(() => assertIntegrationInstruction("继续合并", "merge_and_publish")).toThrow(/不一致/);
    expect(() => assertIntegrationInstruction("继续发布", "merge_only")).toThrow(/不一致/);
    expect(() => assertIntegrationInstruction("继续合并和发布", "publish_only")).toThrow(/不一致/);
  });
  it.each([
    ["合并吗", "merge_only"], ["发布么", "publish_only"],
    ["合并好不好", "merge_only"], ["发布可以吗", "publish_only"],
    ["merge when CI passes", "merge_only"], ["publish tomorrow", "publish_only"],
    ["明天合并", "merge_only"],
  ] as const)("rejects questions and deferred instructions with matching operation: %s", (text, mode) => {
    expect(() => assertIntegrationInstruction(text, mode)).toThrow();
  });
});
