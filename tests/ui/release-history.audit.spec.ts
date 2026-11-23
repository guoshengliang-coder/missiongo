import {expect,test} from '@playwright/test';
import {AUDIT_SOURCE} from './audit-page.mjs';

for(const width of [320,1440])for(const theme of ['light','dark'] as const) {
  test(`historical publication review ${width} ${theme}`,async({page,request},testInfo)=>{
    await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
    const product=await(await request.post('/api/v1/products',{data:{name:'Historical release review',keyPrefix:`H${width}${theme[0]!.toUpperCase()}`}})).json();
    const row={id:'pending',productId:product.id,sessionId:'source',revision:'r',state:'confirmed',summary:'本次 Web 修复',validation:'Synthetic',itemKeys:[],head:'a'.repeat(40),requiredArtifacts:['web'],pullRequestUrl:'https://github.com/example/project/pull/1',evidence:{checkedAt:new Date().toISOString(),source:'Fixture'},queue:{stage:'merge',publishedArtifacts:[],pendingArtifacts:['web'],records:[]}};
    await page.route('**/integration-queue?**',route=>route.fulfill({json:{deliveries:[row],counts:{merge:1}}}));
    await page.route(/\/merge-deliveries(?:\?.*)?$/,route=>route.fulfill({json:{deliveries:[],batches:[]}}));
    let revision=1,blocked=false,reviewed=false;
    await page.route('**/integration-preview',route=>route.fulfill({json:{digest:`scope-${revision}`,requiredArtifacts:['web'],candidates:[{identity:'delivery:pending',title:'本次 Web 修复',selected:true,requiredArtifacts:['web']},{identity:'SYN-1:old',itemKey:'SYN-1',title:'Windows 客户端',selected:false,historicalGapReason:'人工标记开发完成后已退回处理，后续已有独立集成交付；此旧记录缺少集成与范围，保留历史告警，不计为本次交付。',...(reviewed?{historicalGapPreviouslyReviewed:true}:{})}],blockers:blocked?['另一份实际交付缺少发布范围，请补齐后重试']:[]}}));
    await page.route('**/api/v1/nodes',route=>route.fulfill({json:{nodes:[{id:'node',name:'Fixture',online:true,supportsFreeSessions:true,agents:[{kind:'codex',planApprovalProtocol:1,ready:true,models:[]}],repos:[{productId:product.id,repoPath:'fixture'}],repoCandidates:[],createdAt:new Date().toISOString()}]}}));
    for(const name of ['dispatch-defaults','integration-defaults'])await page.route('**/api/v1/'+name,route=>route.fulfill({json:{nodeId:'node',agentKind:'codex',agents:{codex:{mode:'auto'}}}}));
    const bodies:Record<string,unknown>[]=[];
    await page.route('**/merge-batches',route=>{bodies.push(route.request().postDataJSON());return route.fulfill({status:409,json:{error:{message:'Synthetic scope refresh'}}});});
    await page.goto(`/?product=${product.id}&console=agent`);await page.getByRole('button',{name:'待集成 1',exact:true}).click();
    const dialog=page.getByRole('dialog');await dialog.locator('.merge-row input').check();await dialog.getByRole('button',{name:'下一步：配置 Agent'}).click();
    await dialog.getByRole('checkbox',{name:/合并后发布/}).check();
    const review=dialog.getByRole('checkbox',{name:'已审阅以上记录：保留告警，不计为本次交付'}),start=dialog.getByRole('button',{name:'开始处理',exact:true});
    await expect(dialog.getByRole('heading',{name:'核对历史缺证记录'})).toBeVisible();await expect(start).toBeDisabled();
    await expect(dialog.getByText(/额外包含/)).toHaveCount(0);
    await review.check();await expect(start).toBeEnabled();
    for(const scale of ['small','medium','large']) {
      await page.evaluate(value=>document.documentElement.dataset.fontScale=value,scale);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const audit=await page.evaluate(AUDIT_SOURCE) as {text:{fontSize:number;contrast:number;fontWeight:number}[]};
      expect(audit.text.filter(r=>r.fontSize>0&&r.fontSize<11)).toEqual([]);
      expect(audit.text.filter(r=>r.contrast<(r.fontSize>=24||r.fontWeight>=700&&r.fontSize>=18.66?3:4.5))).toEqual([]);
    }
    await review.scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath('history-review.png'),fullPage:true});
    revision=2;await start.click();await expect.poll(()=>bodies.length).toBe(1);expect(bodies[0]).toMatchObject({historicalGapsAcknowledged:true,scopeDigest:'scope-1'});
    await expect(review).not.toBeChecked();await expect(start).toBeDisabled();await review.check();await expect(start).toBeEnabled();
    blocked=true;await start.click();await expect(dialog.getByText('另一份实际交付缺少发布范围，请补齐后重试')).toBeVisible();await expect(start).toBeDisabled();
    // Returning to merge-only remains available without publication approval.
    await dialog.getByRole('checkbox',{name:/合并后发布/}).uncheck();await expect(start).toBeEnabled();
    revision=3;blocked=false;reviewed=true;
    await dialog.getByRole('checkbox',{name:/合并后发布/}).check();
    await expect(review).toHaveCount(0);await expect(start).toBeEnabled();
    await dialog.getByText('查看完整发布清单').click();
    await expect(dialog.getByText(/SYN-1.*历史缺证已审阅/)).toBeVisible();
    await start.click();await expect.poll(()=>bodies.length).toBe(3);
    expect(bodies[2]).toMatchObject({scopeDigest:'scope-3'});
    expect(bodies[2]).not.toHaveProperty('historicalGapsAcknowledged');
  });
}
