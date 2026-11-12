import type { Route } from "@playwright/test";
/** Keep existing offer fixtures and their queue projection consistent after the API split. */
export function queueRoute(route:Route) {
  return {fulfill:(options:Parameters<Route['fulfill']>[0])=>{
    if(!route.request().url().includes('/integration-queue'))return route.fulfill(options);
    const json=options?.json as {deliveries?:{state?:string;blocker?:string;requiredArtifacts?:string[];queue?:unknown}[]}|undefined;
    if(!json?.deliveries)return route.fulfill(options);
    const deliveries=json.deliveries.filter(d=>d.state==='confirmed'||d.state==='merged').map(d=>({...d,queue:d.queue??{stage:d.state==='merged'?'release':'merge',publishedArtifacts:[],pendingArtifacts:d.requiredArtifacts??[],records:[]}}));
    return route.fulfill({...options,json:{...json,deliveries,counts:{merge:deliveries.filter(d=>d.state==='confirmed'&&d.blocker!=='changed').length,release:deliveries.filter(d=>d.state==='merged').length}}});
  }};
}
