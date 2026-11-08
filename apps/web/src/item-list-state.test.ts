import { expect, it } from "vitest";
import { inconsistentItemPage } from "./item-list-state";
import type { WorkItemListPage } from "./api";
const page = { items: [], summary: {total:3,productTotal:100,byStatus:{inbox:1,ready:2,in_progress:0,development_complete:0,on_hold:0,pending_verification:0,done:0,cancelled:0}} } as WorkItemListPage;
it("compares counts in the same page and current status, not the whole product",()=>{
  expect(inconsistentItemPage(page,"ready")).toBe(true);
  expect(inconsistentItemPage(page,"in_progress")).toBe(false);
  expect(inconsistentItemPage(page,"all")).toBe(true);
  expect(inconsistentItemPage(undefined,"ready")).toBe(false);
  expect(inconsistentItemPage({...page,summary:{...page.summary,total:0,byStatus:{...page.summary.byStatus,ready:0}}},"ready")).toBe(false);
});
