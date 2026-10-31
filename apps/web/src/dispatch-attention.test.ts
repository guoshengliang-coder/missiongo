import { describe, expect, it } from "vitest";
import { currentDispatchForStatus, dispatchIssueLabelKey, itemProgressKeys } from "./dispatch-attention";
import { translate } from "./i18n";
import type { ItemDispatchSummary } from "./types";

const attempt: ItemDispatchSummary = {
  dispatchId: "new", itemKey: "AND-329", nodeName: "test-node", agentKind: "codex",
  status: "failed", createdAt: "2026-10-30T00:00:00Z", itemStatus: "ready",
  issue: { kind: "dispatch", reason: "startup error" },
};

const healthy = {...attempt};
delete healthy.issue;

describe("current-stage dispatch attention", () => {
  it("explains waiting for input without pretending the item was claimed",()=>{
    const current={...healthy,status:"launched" as const,waitingForInput:true,sessionStatus:"active" as const,claimed:false};
    expect(itemProgressKeys({status:"ready"},current)).toEqual(["itemWaitingAnswer","itemUnclaimed"]);
    expect(itemProgressKeys({status:"ready"},{...current,claimed:true})).toEqual(["itemWaitingAnswer","itemClaimed"]);
    expect(translate("zh-CN","agentSessionActive")).toBe("运行中");
  });
  it("shows delivery evidence separately from an ended turn or manual card status",()=>{
    expect(itemProgressKeys({status:"ready",deliveryProgress:"waiting_merge"},{...healthy,sessionStatus:"idle"}))
      .toEqual(["itemWaitingMerge"]);
    expect(itemProgressKeys({status:"inbox",deliveryProgress:"waiting_release"})).toEqual(["itemWaitingRelease"]);
    expect(itemProgressKeys({status:"in_progress"},{...healthy,sessionStatus:"idle"})).toEqual(["agentSessionIdle"]);
    expect(itemProgressKeys({status:"ready",deliveryProgress:"review_required"})).toEqual(["itemDeliveryReview"]);
  });
  it.each(["inbox", "development_complete", "pending_verification", "done", "cancelled", "on_hold"] as const)(
    "rejects even a cached failure for %s", status => {
      expect(currentDispatchForStatus(status, attempt)).toBeUndefined();
    },
  );
  it("does not carry a ready-stage failure into in-progress work while a poll is stale", () => {
    expect(currentDispatchForStatus("in_progress", attempt)).toBeUndefined();
    expect(currentDispatchForStatus("ready", undefined)).toBeUndefined();
    expect(currentDispatchForStatus("ready", attempt)).toBe(attempt);
    const claimed = { ...attempt, itemStatus: "in_progress" as const };
    expect(currentDispatchForStatus("in_progress", claimed)).toBe(claimed);
  });
  it("distinguishes a startup failure and an execution issue in both languages", () => {
    expect(translate("zh-CN", dispatchIssueLabelKey({ kind: "dispatch" }))).toBe("派单失败");
    expect(translate("zh-CN", dispatchIssueLabelKey({ kind: "execution" }))).toBe("执行异常");
    expect(translate("en", dispatchIssueLabelKey({ kind: "execution" }))).toBe("Execution issue");
  });
});
