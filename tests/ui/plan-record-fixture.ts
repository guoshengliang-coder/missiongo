import type {Page} from "@playwright/test";
/** A formal read-model fixture, kept separate from the original transcript. */
export async function mockLegacyPlanRecords(page:Page,sessionId:string,plan:string,validation:string,approved:()=>boolean=()=>true) {
  await page.route(url=>url.pathname===`/api/v1/agent-sessions/${sessionId}/plan-records`,route=>{
    const detail=new URL(route.request().url()).searchParams.has("recordId");
    return route.fulfill({json:{historyIncomplete:true,records:[{id:1,revision:"fixture",keys:[],kind:"proposal",current:true,
      effective:approved(),scopeValid:true,legacy:true,...(approved()?{approval:{source:"web",approvedAt:"2026-11-08T00:00:00Z"}}:{}),
      ...(detail?{plan,validation}:{})}]}});
  });
}
