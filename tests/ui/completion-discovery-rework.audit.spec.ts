import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { MissionGoStore } from "../../services/server/dist/store.js";
import { DispatchStore } from "../../services/server/dist/dispatch-store.js";

const completion={kind:"github",url:"https://github.com/example/project/pull/385"};
const fixtureNodes:string[]=[];
function fixtureStore() {
  const directory=process.env.MISSIONGO_UI_FIXTURE_DATA;
  if(!directory) throw new Error("Isolated UI fixture is required");
  return new MissionGoStore(join(directory,"missiongo.sqlite"));
}
function setup() {
  const store=fixtureStore();
  try {
    const product=store.createProduct({name:"Completion discovery rework",keyPrefix:`CD${randomUUID().slice(0,6).toUpperCase()}`,createdByAccountId:"ui-fixture"});
    store.recordProductReleaseArtifacts(product.id,["web"]);
    const item=store.createWorkItem({productId:product.id,title:"Retain discovered references",description:"Repeated status actions must retain candidates",type:"bug",priority:"normal",status:"ready",environment:{platform:"web"}});
    store.claimWorkItem({itemKey:item.key,agentId:"test",idempotencyKey:randomUUID(),attribution:{accountId:"ui-fixture",clientId:"ui-fixture"}});
    const nodes=new DispatchStore(store.database);
    const node=nodes.registerNode({accountId:"ui-fixture",installationId:randomUUID(),name:"Discovery fixture node"});
    fixtureNodes.push(node.nodeId);
    nodes.replaceRepos("ui-fixture",node.nodeId,[{productId:product.id,repoPath:"/example/repository"}]);
    return {product,item,node};
  } finally {store.close();}
}
test.afterEach(()=>{
  const store=fixtureStore();
  try {for(const id of fixtureNodes.splice(0))new DispatchStore(store.database).revokeNode("ui-fixture",id);}
  finally {store.close();}
});
test.use({hasTouch:true});
for(const width of [320,1440]) for(const theme of ["light","dark"] as const) {
  test(`real discovery survives reopening, repeated checks and explicit retry ${width} ${theme}`,async({page,request})=>{
    const {product,item,node}=setup();
    const path=`/api/v1/items/${item.key}/status-checks`;
    const headers={authorization:`Bearer ${node.token}`};
    const claim=async()=>{
      const response=await request.post("/api/v1/node/completion-discovery/claim",{headers,data:{}});
      expect(response.ok()).toBe(true);
      return (await response.json()).job as {id:string;leaseToken:string};
    };
    const report=async(job:{id:string;leaseToken:string})=>{
      const response=await request.post(`/api/v1/node/completion-discovery/${job.id}/report`,{headers,data:{leaseToken:job.leaseToken,repository:"https://github.com/example/project",candidates:[{completion,title:"Found reference",state:"merged"}]}});
      expect(response.ok()).toBe(true);
    };
    expect((await request.post(path)).ok()).toBe(true);
    await report(await claim());
    let posts=0;
    page.on("request",r=>{if(r.method()==="POST" && new URL(r.url()).pathname===path)posts++;});
    await page.setViewportSize({width,height:width===320?640:900});
    await page.emulateMedia({colorScheme:theme});
    await page.goto(`/?product=${product.id}&status=in_progress&item=${item.key}`);
    const open=()=>page.locator(".detail-toolbar").getByRole("button",{name:"标记开发完成",exact:true}).click();
    const dialog=page.getByRole("dialog");
    const reference=dialog.getByText("Found reference",{exact:true});
    await open();
    await expect(reference).toBeVisible();
    await dialog.getByRole("button",{name:"刷新结果",exact:true}).click();
    await expect(reference).toBeVisible();expect(posts).toBe(0);
    await dialog.getByRole("button",{name:"关闭",exact:true}).click();
    await page.goto(`/?product=${product.id}&status=in_progress`);
    const rowMenu=page.locator(".row-more-menu");
    await rowMenu.locator(":scope > summary").click();
    await rowMenu.getByRole("button",{name:"标记开发完成",exact:true}).click();
    await expect(reference).toBeVisible();expect(posts).toBe(0);
    await dialog.getByRole("button",{name:"关闭",exact:true}).click();
    await page.goto(`/?product=${product.id}&status=in_progress&item=${item.key}`);
    await open();await expect(reference).toBeVisible();
    for(let n=0;n<2;n++) {
      await dialog.getByRole("button",{name:"立即检查并校正",exact:true}).click();
      await expect(dialog.getByRole("button",{name:"立即检查并校正",exact:true})).toBeEnabled();
      await expect(reference).toBeVisible();
    }
    expect(posts).toBe(2);
    expect((await (await request.get(path)).json()).discovery.status).toBe("found");
    await dialog.getByRole("button",{name:"重新查找完成依据",exact:true}).click();
    await expect(dialog.getByText(/查找已排队/)).toBeVisible();
    await expect(reference).toHaveCount(0);
    await expect(dialog.getByRole("button",{name:"立即检查并校正",exact:true})).toBeDisabled();
    const retry=await claim();
    await dialog.getByRole("button",{name:"关闭",exact:true}).click();
    await open();
    await expect(dialog.getByRole("button",{name:"立即检查并校正",exact:true})).toBeDisabled();
    await report(retry);
    // Use the real polling path after a delayed node report, not a mocked GET.
    await expect(reference).toBeVisible({timeout:12_000});expect(posts).toBe(3);
    for(const scale of ["small","medium","large"]) {
      await page.evaluate(value=>{document.documentElement.dataset.fontScale=value;},scale);
      expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    }
    await page.screenshot({path:test.info().outputPath(`retained-${width}-${theme}.png`)});
    await dialog.getByRole("button",{name:"选择此依据",exact:true}).click();
    await expect(dialog.getByLabel("PR URL",{exact:true})).toHaveValue(completion.url);
    await dialog.getByLabel("web",{exact:true}).check();
    expect((await request.post(path)).ok()).toBe(true);
    await expect(dialog.getByLabel("web",{exact:true})).toBeChecked();
    await dialog.getByRole("button",{name:"确认并保存关联",exact:true}).click();
    await expect(dialog.getByText("等待关联节点检查",{exact:true})).toBeVisible();
    const saved=await (await request.get(path)).json();
    expect(saved.items[0]).toMatchObject({completion,requiredArtifacts:["web"],itemStatus:"in_progress"});
  });
}
