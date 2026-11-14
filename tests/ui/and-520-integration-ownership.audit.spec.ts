import {expect,test} from '@playwright/test';
import {AUDIT_SOURCE} from './audit-page.mjs';

test.beforeEach(async({page})=>{await page.clock.setFixedTime(new Date('2026-11-14T02:00:00Z'));});
const at='2026-11-14T02:00:00Z';
const ownershipViews=[...[320,1440].flatMap(width=>(['light','dark'] as const).map(theme=>({width,theme,stage:'all'}))),{width:320,theme:'light' as const,stage:'release'}];
for(const {width,theme,stage} of ownershipViews) {
  test(`AND-520 queue ownership transitions ${stage} ${width} ${theme}`,async({page,request},testInfo)=>{
    await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
    const product=await(await request.post('/api/v1/products',{data:{name:`Ownership ${stage} ${width} ${theme}`,keyPrefix:`OWN${width}${theme[0]!.toUpperCase()}${stage==='release'?'R':''}`}})).json();
    const row={id:'released-later',productId:product.id,sessionId:'source',revision:'exact-head',state:'merged',summary:'原批次中的发布范围',validation:'Synthetic',itemKeys:[],head:'a'.repeat(40),requiredArtifacts:['web','macosApp'],pullRequestUrl:'https://github.com/example/project/pull/1',evidence:{checkedAt:at,source:'Fixture'},queue:{stage:'release',publishedArtifacts:['web'],pendingArtifacts:['macosApp'],records:[]}};
    let active=false,privateBatch=false;
    await page.route('**/integration-queue?**',route=>{
      const stage=new URL(route.request().url()).searchParams.get('stage');
      return route.fulfill({json:{deliveries:!active&&['all','release'].includes(stage??'all')?[row]:[],counts:active?{}:{release:1},occupancy:{active,...(active&&!privateBatch?{sessionId:'original-integration'}:{})}}});
    });
    // A stale second API must not override the queue's current occupancy.
    await page.route(/\/merge-deliveries(?:\?.*)?$/,route=>route.fulfill({json:{deliveries:[],batches:[{id:'stale',sessionId:'unrelated',state:'active',deliveries:[],results:{},publish:false}]}}));
    await page.route('**/api/v1/nodes',route=>route.fulfill({json:{nodes:[{id:'node',name:'Fixture',online:true,supportsFreeSessions:true,agents:[{kind:'codex',planApprovalProtocol:1,ready:true,models:[]}],repos:[{productId:product.id,repoPath:'fixture'}],repoCandidates:[],createdAt:at}]}}));
    for(const key of ['dispatch-defaults','integration-defaults'])await page.route('**/api/v1/'+key,route=>route.fulfill({json:{nodeId:'node',agentKind:'codex',agents:{codex:{mode:'auto'}}}}));
    await page.goto(`/?product=${product.id}&console=agent`);
    await page.getByRole('button',{name:'待集成 1',exact:true}).click();const dialog=page.getByRole('dialog');
    await expect(dialog.locator('.merge-active-notice')).toHaveCount(0);
    if(stage==='release')await dialog.getByRole('button',{name:'待发布 1',exact:true}).click();
    await dialog.locator('.merge-row input').check();await expect(dialog.getByRole('button',{name:'下一步：配置 Agent'})).toBeEnabled();
    const change=async(title:string)=>{const response=await request.post('/api/v1/items',{data:{productId:product.id,type:'note',priority:'normal',title,description:'',environment:{platform:'web'}}});expect(response.ok()).toBe(true);};
    active=true;await change('Batch accepted');
    await expect(dialog.getByRole('button',{name:'全部 0',exact:true})).toBeVisible();
    await expect(dialog.locator('.merge-row')).toHaveCount(0);await expect(dialog.getByRole('button',{name:'下一步：配置 Agent'})).toBeDisabled();
    await expect(dialog.getByText('已选 1 组改动',{exact:true})).toHaveCount(0);await expect(dialog.getByRole('button',{name:'重新选择',exact:true})).toHaveCount(0);
    await expect(dialog.getByRole('button',{name:'进入合并会话',exact:true})).toBeVisible();
    privateBatch=true;await change('Other account owns the batch');
    await expect(dialog.locator('.merge-active-notice')).toContainText('请由原执行者继续处理');
    await expect(dialog.getByRole('button',{name:'进入合并会话',exact:true})).toHaveCount(0);
    await expect(dialog).not.toContainText('unrelated');
    for(const scale of ['small','medium','large']) {
      await page.evaluate(value=>document.documentElement.dataset.fontScale=value,scale);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const audit=await page.evaluate(AUDIT_SOURCE) as {text:{fontSize:number;contrast:number;fontWeight:number}[]};
      expect(audit.text.filter(r=>r.fontSize>0&&r.fontSize<11)).toEqual([]);
      expect(audit.text.filter(r=>r.contrast<(r.fontSize>=24||r.fontWeight>=700&&r.fontSize>=18.66?3:4.5))).toEqual([]);
    }
    await page.screenshot({path:testInfo.outputPath(`owned-${width}-${theme}.png`),fullPage:true,animations:'disabled'});
    active=false;await change('Original batch formally finished');
    await expect(dialog.getByRole('button',{name:'全部 1',exact:true})).toBeVisible();
    await expect(dialog.locator('.merge-active-notice')).toHaveCount(0);await expect(dialog.locator('.merge-row')).toHaveCount(1);
    await expect(dialog).toContainText('待发布产物: macOS');
  });
}

test('AND-520 unknown response retries the accepted request despite its own active occupancy',async({page,request})=>{
  const product=await(await request.post('/api/v1/products',{data:{name:'Owned retry',keyPrefix:'OWNRETRY'}})).json();
  const row={id:'pending',productId:product.id,sessionId:'source',revision:'r',state:'confirmed',summary:'原请求范围',validation:'Synthetic',itemKeys:[],head:'a'.repeat(40),requiredArtifacts:['web'],pullRequestUrl:'https://github.com/example/project/pull/1',evidence:{checkedAt:at,source:'Fixture'},queue:{stage:'merge',publishedArtifacts:[],pendingArtifacts:['web'],records:[]}};
  const bodies:Record<string,unknown>[]=[];
  await page.route('**/integration-queue?**',route=>route.fulfill({json:{deliveries:bodies.length?[]:[row],counts:bodies.length?{}:{merge:1},occupancy:bodies.length?{active:true,sessionId:'accepted-original',requestKey:bodies[0]!.requestKey}:{active:false}}}));
  await page.route(/\/merge-deliveries(?:\?.*)?$/,route=>route.fulfill({json:{deliveries:[],batches:[]}}));
  await page.route('**/api/v1/nodes',route=>route.fulfill({json:{nodes:[{id:'node',name:'Fixture',online:true,supportsFreeSessions:true,agents:[{kind:'codex',planApprovalProtocol:1,ready:true,models:[]}],repos:[{productId:product.id,repoPath:'fixture'}],repoCandidates:[],createdAt:at}]}}));
  for(const key of ['dispatch-defaults','integration-defaults'])await page.route('**/api/v1/'+key,route=>route.fulfill({json:{nodeId:'node',agentKind:'codex',agents:{codex:{mode:'auto'}}}}));
  await page.route('**/merge-batches',route=>{bodies.push(route.request().postDataJSON());return route.fulfill({status:503,json:{title:'Synthetic response unknown'}});});
  await page.goto(`/?product=${product.id}&console=agent`);await page.getByRole('button',{name:'待集成 1',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.locator('.merge-row input').check();await dialog.getByRole('button',{name:'下一步：配置 Agent'}).click();
  await dialog.getByRole('button',{name:'开始处理',exact:true}).click();
  await expect(dialog.locator('.merge-active-notice')).toBeVisible();
  const retry=dialog.getByRole('button',{name:'重试原批次',exact:true});await expect(retry).toBeEnabled();await retry.click();
  await expect.poll(()=>bodies.length).toBe(2);expect(bodies[1]).toEqual(bodies[0]);
});
