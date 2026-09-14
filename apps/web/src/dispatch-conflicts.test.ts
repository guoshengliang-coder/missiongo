import { describe, expect, it } from "vitest";

import {
  activeDispatchStatusKey,
  activeDispatchesByItem,
  conflictSignature,
  dispatchConflicts,
  includesQueued,
} from "./dispatch-conflicts";
import { dispatchProblemKey } from "./dispatch-eligibility";
import { translate } from "./i18n";
import type { ActiveDispatch } from "./types";

const active = (itemKey: string, overrides: Partial<ActiveDispatch> = {}): ActiveDispatch => ({
  dispatchId: `d-${itemKey}`,
  itemKey,
  nodeName: "Mac mini",
  status: "launched",
  createdAt: "2026-09-14T10:00:00Z",
  ...overrides,
});

describe("finding the selected items that were already dispatched", () => {
  it("returns only the selected items that have an unclaimed dispatch, in selection order", () => {
    const byItem = activeDispatchesByItem([active("AND-37"), active("AND-40"), active("AND-12")]);
    expect(dispatchConflicts(["AND-40", "AND-38", "AND-37"], byItem).map((entry) => entry.itemKey))
      .toEqual(["AND-40", "AND-37"]);
  });

  it("finds nothing when none of the selection was dispatched", () => {
    expect(dispatchConflicts(["AND-38"], activeDispatchesByItem([active("AND-37")]))).toEqual([]);
    expect(dispatchConflicts(["AND-38"], activeDispatchesByItem([]))).toEqual([]);
  });

  it("does not list an item twice when the selection repeats it", () => {
    expect(dispatchConflicts(["AND-37", "AND-37"], activeDispatchesByItem([active("AND-37")]))).toHaveLength(1);
  });

  it("keeps the newest dispatch when an item has more than one", () => {
    const byItem = activeDispatchesByItem([
      active("AND-37", { dispatchId: "old", nodeName: "MacBook", createdAt: "2026-09-14T09:00:00Z" }),
      active("AND-37", { dispatchId: "new", nodeName: "Mac mini", createdAt: "2026-09-14T11:00:00Z" }),
      active("AND-37", { dispatchId: "middle", createdAt: "2026-09-14T10:00:00Z" }),
    ]);
    expect(byItem.get("AND-37")).toMatchObject({ dispatchId: "new", nodeName: "Mac mini" });
  });

  it("says when one of them is still queued, which re-dispatching cancels", () => {
    expect(includesQueued([active("AND-37"), active("AND-40", { status: "delivered" })])).toBe(false);
    expect(includesQueued([active("AND-37"), active("AND-40", { status: "queued" })])).toBe(true);
  });
});

describe("the tick that allows a second dispatch", () => {
  it("stops counting once a refetch turns up a different set of earlier dispatches", () => {
    const ticked = conflictSignature([active("AND-37")]);
    expect(conflictSignature([active("AND-37")])).toBe(ticked);
    expect(conflictSignature([active("AND-37"), active("AND-40")])).not.toBe(ticked);
    expect(conflictSignature([active("AND-37", { dispatchId: "someone-else" })])).not.toBe(ticked);
  });
});

describe("wording for an unclaimed dispatch", () => {
  it("names each active state without reusing 领取, which the item's own claim already means", () => {
    expect(translate("zh-CN", activeDispatchStatusKey("queued")!)).toBe("排队中");
    expect(translate("zh-CN", activeDispatchStatusKey("delivered")!)).toBe("已送达");
    expect(translate("zh-CN", activeDispatchStatusKey("launched")!)).toBe("已启动");
  });

  it("leaves a status this build does not know to be shown as itself", () => {
    expect(activeDispatchStatusKey("failed")).toBeNull();
    expect(activeDispatchStatusKey("paused")).toBeNull();
  });

  it("puts the machine on the row and the whole story in the dialog", () => {
    expect(translate("zh-CN", "activeDispatchBadge", { node: "Mac mini" })).toBe("已派给 Mac mini");
    expect(translate("zh-CN", "dispatchConflictLine", {
      key: "AND-37",
      node: "Mac mini",
      status: translate("zh-CN", "activeDispatchLaunched"),
      time: "10 分钟前",
    })).toBe("AND-37 已派给 Mac mini（已启动，10 分钟前），还没有被领取");
    expect(translate("zh-CN", "dispatchConflictConfirm")).toBe("上一次的会话已经不在了，仍要重新派单");
  });

  it("explains the server's refusal instead of showing its English title", () => {
    const key = dispatchProblemKey("item_already_dispatched");
    expect(key).not.toBeNull();
    expect(translate("zh-CN", key!)).toContain("勾选");
  });
});
