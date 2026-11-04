import {readFileSync} from "node:fs";
import {expect,test} from "@playwright/test";
import {postItemCommand} from "./item-command";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string};
test.use({hasTouch:true});
const discoveryId="00000000-0000-4000-8000-000000000001";
const completion={kind:"github",url:"https://github.com/example/project/pull/385"};
for (const width of [320,768,1440]) for (const theme of ["light","dark"] as const) {
 test(`completion discovery confirmation ${width} ${theme}`,async({page,request})=>{
  const created=await request.post("/api/v1/items",{data:{productId:fixture.productId,title:"Discover completion",description:"Find existing Agent comment reference",type:"bug",priority:"normal",status:"ready",environment:{platform:"web"}}});
  const item=await created.json() as {key:string};
  expect((await postItemCommand(request,`/api/v1/items/${item.key}/transitions`,{data:{to:"in_progress",reason:"claim"}})).ok()).toBe(true);
  let state:string|null=null,saved=false,posts=0;
  const record={id:discoveryId,itemKey:item.key,productId:fixture.productId,itemStatus:"in_progress",completion,pullRequestUrl:completion.url,requiredArtifacts:null,noReleaseReason:null,status:"waiting_node",reason:"",checkedAt:null,requestedAt:new Date().toISOString(),evidenceUpdatedAt:new Date().toISOString(),evidenceSource:"authorized_executor",evidence:{}};
  const body=()=>({items:saved?[record]:[],discovery:state ? {id:discoveryId,status:state,repository:"https://github.com/example/project",candidates:state==="found"?[{completion,title:"Fix completion reference from Agent comment",state:"merged",commentId:"00000000-0000-4000-8000-000000000002"}]:[]} : null});
  await page.route(`**/api/v1/items/${item.key}/status-checks*`,async route=>{
   if(route.request().method()==="POST") { posts++; state ??="waiting_node"; }
   await route.fulfill({json:body()});
  });
  await page.route(`**/api/v1/items/${item.key}/handover`,async route=>{
   expect(route.request().postDataJSON()).toMatchObject({completion,discoverySelection:{discoveryId,candidateIndex:0}});
   saved=true;await route.fulfill({json:{handover:record}});
  });
  await page.setViewportSize({width,height:width===320?640:900});await page.emulateMedia({colorScheme:theme});
  await page.goto(`/?product=${fixture.productId}&item=${item.key}`);
  await page.locator(".detail-toolbar").getByRole("button",{name:"标记开发完成",exact:true}).click();
  const dialog=page.getByRole("dialog");
  await expect(dialog.getByText(/查找已排队/)).toBeVisible();expect(posts).toBe(1);
  state="permission_failed";await dialog.getByRole("button",{name:"刷新结果",exact:true}).click();
  await expect(dialog.getByText(/节点无法访问仓库/)).toBeVisible();
  state="empty";await dialog.getByRole("button",{name:"刷新结果",exact:true}).click();
  await expect(dialog.getByText(/未找到完成依据/)).toBeVisible();
  state="found";await dialog.getByRole("button",{name:"刷新结果",exact:true}).click();
  await expect(dialog.getByText("查询显示已合并",{exact:true})).toBeVisible();
  await expect(dialog.getByRole("link",{name:"来源：本轮评论",exact:true})).toBeVisible();
  for (const scale of ["small","medium","large"]) {
   await page.evaluate(value=>{document.documentElement.dataset.fontScale=value;},scale);
   expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
   await dialog.getByRole("button",{name:"选择此依据",exact:true}).scrollIntoViewIfNeeded();
   const bounds=await dialog.getByRole("button",{name:"选择此依据",exact:true}).boundingBox();
   expect(bounds && bounds.width>=44 && bounds.height>=44 && bounds.x>=0 && bounds.x+bounds.width<=width).toBeTruthy();
  }
  await page.screenshot({path:test.info().outputPath(`candidates-${width}-${theme}.png`)});
  await dialog.getByRole("button",{name:"选择此依据",exact:true}).click();
  await expect(dialog.getByLabel("PR URL",{exact:true})).toHaveValue(completion.url);
  await dialog.getByRole("button",{name:"取消",exact:true}).click();
  await dialog.getByRole("button",{name:"选择此依据",exact:true}).click();
  await dialog.getByRole("button",{name:"确认并保存关联",exact:true}).click();
  await expect(dialog.getByText("等待关联节点检查",{exact:true})).toBeVisible();
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:test.info().outputPath(`discovery-${width}-${theme}.png`)});
 });
}
test("real quick action queues discovery and retains manual fallback",async({page,request})=>{
 const created=await request.post("/api/v1/items",{data:{productId:fixture.productId,title:"Queue discovery",description:"No evidence yet",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}}});
 const item=await created.json() as {key:string};
 await postItemCommand(request,`/api/v1/items/${item.key}/transitions`,{data:{to:"in_progress",reason:"claim"}});
 await page.goto(`/?product=${fixture.productId}&item=${item.key}`);
 await page.locator(".detail-toolbar").getByRole("button",{name:"标记开发完成",exact:true}).click();
 const dialog=page.getByRole("dialog");await expect(dialog.getByText(/查找已排队/)).toBeVisible();
 await dialog.getByRole("button",{name:"关联完成依据 / 确认发布范围",exact:true}).click();
 await expect(dialog.getByLabel("PR URL",{exact:true})).toHaveValue("");
 await dialog.getByRole("button",{name:"取消",exact:true}).click();
 await expect(dialog.getByText(/查找已排队/)).toBeVisible();
});
