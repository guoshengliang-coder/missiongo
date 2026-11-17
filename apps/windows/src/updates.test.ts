import { expect, it, vi } from "vitest";
import { DesktopUpdates } from "./updates.js";
it("does not accept late completion after cancellation and permits a clean retry after settlement", () => {
  const update = new DesktopUpdates(); const cancel = vi.fn(); update.available("0.1.1","本次更新内容"); update.begin(cancel);
  update.progress({percent:50, transferred:50, total:100}); expect(update.snapshot.percent).toBe(50);
  update.cancel(); expect(cancel).toHaveBeenCalledOnce(); expect(update.verifying()).toBe(false);
  expect(() => update.begin(cancel)).toThrow(); update.failed(); expect(update.snapshot.state).toBe("cancelling");
  update.settled(true); expect(update.snapshot.state).toBe("cancelled"); update.begin(cancel);
  expect(update.verifying()).toBe(true); update.verified(true); update.settled(); update.installing();
  expect(update.snapshot.state).toBe("installing"); update.deferInstall(); expect(update.snapshot.state).toBe("ready"); expect(update.snapshot.notes).toBe("本次更新内容");
});
it("requires trusted verification, rejects concurrent checks and keeps invalid progress out of the snapshot", () => {
  const update = new DesktopUpdates(); update.checking(); update.available("0.1.1"); update.begin(() => {});
  expect(() => update.checking()).toThrow(); update.progress({percent:NaN, transferred:0, total:0}); expect(update.snapshot.percent).toBe(0);
  expect(update.verifying()).toBe(true); expect(() => update.cancel()).toThrow(); update.verified(false); update.settled();
  expect(() => update.installing()).toThrow(); expect(update.snapshot).toMatchObject({state:"failed",version:"0.1.1"});
});

it("rejects overlapping checks and stale completion from a different target version",()=>{
  const update=new DesktopUpdates();update.checking();expect(()=>update.checking()).toThrow();
  update.available("0.1.2");update.begin(()=>{});expect(update.verifying("0.1.1")).toBe(false);expect(update.snapshot.state).toBe("downloading");
  expect(update.verifying("0.1.2")).toBe(true);update.verified(true);update.settled();update.installing();expect(()=>update.checking()).toThrow();
});
