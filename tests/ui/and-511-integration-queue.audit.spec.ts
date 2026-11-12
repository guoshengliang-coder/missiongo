import {expect,test} from '@playwright/test';
import {AUDIT_SOURCE} from './audit-page.mjs';

test.beforeEach(async({page})=>{await page.clock.setFixedTime(new Date('2026-11-12T00:00:00Z'));});
for(const width of [320,1440])for(const theme of ['light','dark'] as const) {
  test(`AND-511 mixed queue, inline publication scope and frozen retry ${width} ${theme}`,async({page,request},testInfo)=>{
    await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme});
    const product=await(await request.post('/api/v1/products',{data:{name:`Queue ${width} ${theme}`,keyPrefix:`Q${width}${theme[0]!.toUpperCase()}`}})).json();
    const at='2026-11-12T00:00:00Z';
    const rows=[{id:'pending',state:'confirmed',summary:'附件预览体验优化',queue:{stage:'merge',publishedArtifacts:[],pendingArtifacts:['web'],records:[]}},
      {id:'merged',state:'merged',summary:'控制台消息发送可靠性',queue:{stage:'release',publishedArtifacts:[],pendingArtifacts:['web'],records:[]}},
      {id:'partial',state:'merged',summary:'Android 附件上传修复',queue:{stage:'release',publishedArtifacts:['web'],pendingArtifacts:['androidApp'],records:[]}}]
      .map((d,i)=>({...d,productId:product.id,sessionId:'source',revision:'rev-'+d.id,itemKeys:i===2?[]:[`QA-${i+1}`],head:'a'.repeat(40),validation:'Synthetic verified checks',requiredArtifacts:i===2?['web','androidApp']:['web'],pullRequestUrl:`https://github.com/example/project/pull/${i+1}`,evidence:{checkedAt:at,source:'Fixture'}}));
    await page.route(/\/merge-deliveries(?:\?.*)?$/,route=>route.fulfill({json:{deliveries:[],batches:[]}}));
    await page.route('**/integration-queue?**',route=>{
      const stage=new URL(route.request().url()).searchParams.get('stage');
      return route.fulfill({json:{deliveries:stage==='history'?[]:rows.filter(d=>stage==='all'||stage===d.queue.stage),counts:{merge:1,release:2}}});
    });
    await page.route('**/api/v1/nodes',route=>route.fulfill({json:{nodes:[{id:'node',name:'Fixture node',online:true,supportsFreeSessions:true,agents:[{kind:'codex',planApprovalProtocol:1,ready:true,models:[]}],repos:[{productId:product.id,repoPath:'fixture'}],repoCandidates:[],createdAt:at}]}}));
    for(const suffix of ['dispatch-defaults','integration-defaults'])await page.route('**/api/v1/'+suffix,route=>route.fulfill({json:{nodeId:'node',agentKind:'codex',agents:{codex:{mode:'auto'}}}}));
    let previews=0;const bodies:Record<string,unknown>[]=[];
    await page.route('**/integration-preview',route=>{previews++;return route.fulfill({json:{digest:'reviewed-scope',requiredArtifacts:['web','androidApp'],blockers:[],candidates:[{identity:'selection:pending',title:rows[0]!.summary,selected:true,requiredArtifacts:['web']},{identity:'delivery:merged',title:rows[1]!.summary,selected:true,requiredArtifacts:['web']},{identity:'delivery:partial',title:rows[2]!.summary,selected:false,requiredArtifacts:['web','androidApp']}]}});});
    await page.route('**/merge-batches',route=>{bodies.push(route.request().postDataJSON());return route.fulfill({status:bodies.length===1?409:503,json:{title:'Synthetic rejected first merge / subsequent response lost'}});});
    await page.goto(`/?product=${product.id}&console=agent`);
    await page.getByRole('button',{name:'待集成 3',exact:true}).click();
    const dialog=page.getByRole('dialog');
    const history=dialog.locator('.modal > header').getByRole('button',{name:'交付历史',exact:true});
    await expect(history).toBeVisible();await expect(history).toHaveText('');await expect(history).toHaveAttribute('title','交付历史');
    await expect(dialog.locator('.merge-step-number')).toHaveText(['1','2']);
    await expect(dialog.locator('.merge-steps [aria-current="step"]')).toContainText('选择处理内容');
    const title=await dialog.getByRole('heading',{name:'待集成',exact:true}).boundingBox(),historyBox=await history.boundingBox();
    expect(historyBox!.x).toBeGreaterThan(title!.x+title!.width);
    expect(Math.abs(historyBox!.y-title!.y)).toBeLessThan(20);
    await expect(dialog.getByRole('button',{name:/部分发布|已交付/})).toHaveCount(0);
    await expect(dialog.getByText('已发布产物: Web',{exact:true})).toBeVisible();
    const boxes=dialog.locator('.merge-row input');await boxes.nth(0).check();await boxes.nth(1).check();
    await dialog.getByRole('button',{name:'交付历史',exact:true}).click();
    await expect(page.getByRole('heading',{name:'交付历史',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'查看交付历史说明',exact:true}).click();
    await expect(page.getByRole('region',{name:'交付历史',exact:true})).toContainText('发布完成不代表人工验收');
    await page.keyboard.press('Escape');await page.keyboard.press('Escape');
    await expect(boxes.nth(0)).toBeChecked();await expect(boxes.nth(1)).toBeChecked();
    await page.screenshot({path:testInfo.outputPath(`queue-${width}-${theme}.png`),fullPage:true,animations:'disabled'});
    await dialog.getByRole('button',{name:'下一步：配置 Agent'}).click();
    await expect(dialog.locator('.merge-steps [aria-current="step"]')).toContainText('配置与确认');
    await expect(dialog.getByRole('checkbox',{name:/合并后发布/})).not.toBeChecked();expect(previews).toBe(0);
    await expect(dialog.getByRole('heading',{name:'本次处理',exact:true})).toBeVisible();
    await expect(dialog.locator('.merge-processing-scope')).toContainText('合并 1 组改动');
    await expect(dialog.getByRole('heading',{name:'发布范围',exact:true})).toHaveCount(0);
    await expect(dialog.locator('.help-option > small')).toHaveCount(0);
    await expect(dialog.locator('.merge-processing-scope .merge-selection-summary')).toHaveCount(0);
    await page.evaluate(()=>document.documentElement.dataset.fontScale='large');
    await page.screenshot({path:testInfo.outputPath(`merge-only-${width}-${theme}.png`),fullPage:true,animations:'disabled'});
    await dialog.getByRole('button',{name:'开始处理',exact:true}).click();await expect(dialog.getByRole('alert')).toBeVisible();
    expect(bodies[0]).toMatchObject({operation:'merge_only',publish:false,selection:[{id:'pending',revision:'rev-pending'}]});
    expect(bodies[0]).not.toHaveProperty('scopeDigest');expect(previews).toBe(0);
    // Reopen a clean view after the intentional rejection before taking publication screenshots.
    await page.reload();await page.getByRole('button',{name:'待集成 3',exact:true}).click();
    await boxes.nth(0).check();await boxes.nth(1).check();
    await dialog.getByRole('button',{name:'下一步：配置 Agent'}).click();
    await dialog.getByRole('checkbox',{name:/合并后发布/}).check();
    await expect(dialog.getByRole('heading',{name:'发布范围',exact:true})).toBeVisible();
    await dialog.getByRole('checkbox',{name:/合并后发布/}).uncheck();
    await expect(dialog.getByRole('heading',{name:'本次处理',exact:true})).toBeVisible();
    await expect(dialog.locator('.merge-processing-scope')).toContainText('合并 1 组改动');
    await dialog.getByRole('checkbox',{name:/合并后发布/}).check();
    await expect(dialog.getByRole('heading',{name:'发布范围'})).toBeVisible();
    await expect(dialog.getByText('处理所选改动并验证后合并，超出原需求另行确认。',{exact:true})).toHaveCount(0);
    const scopeHelp=dialog.getByRole('button',{name:'查看本次处理说明',exact:true});
    await scopeHelp.click();await expect(page.getByRole('region',{name:'本次处理',exact:true})).toContainText('预览依据已登记事实');
    await page.keyboard.press('Escape');await expect(scopeHelp).toBeFocused();
    await expect(dialog.getByText('预览依据已登记事实；执行端仍须核对实时 Git 与公开产物。新增范围须重新审阅；重试沿用原请求。',{exact:true})).toHaveCount(0);
    await expect(dialog.getByRole('button',{name:'取消',exact:true})).toHaveCount(0);
    const processing=dialog.locator('.merge-processing-scope');
    await expect(processing.getByRole('heading',{name:'本次处理',exact:true})).toBeVisible();
    await expect(processing.locator('.merge-selection-summary > summary')).toContainText('已选 2 组');
    await expect(processing.locator('.merge-stage-summary')).toHaveText('待合并 1 · 已合并 1');
    expect(await dialog.locator('.merge-config').evaluate(el=>Boolean(el.compareDocumentPosition(el.parentElement!.querySelector('.merge-processing-scope')!)&Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await expect(dialog.locator('.merge-footer')).not.toContainText('已选');
    const extra=dialog.locator('.merge-extra-scope');
    await expect(extra.locator('summary')).toContainText('额外包含 1 组已合并改动');
    await expect(extra.getByText('Android 附件上传修复 · Web / Android',{exact:true})).toBeHidden();
    await extra.locator('summary').click();await expect(extra).toContainText('Android 附件上传修复');
    await extra.locator('summary').click();
    await expect(dialog.getByRole('button',{name:/审阅发布|第三步/})).toHaveCount(0);
    for(const scale of ['small','medium','large']) {
      await page.evaluate(value=>document.documentElement.dataset.fontScale=value,scale);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const audit=await page.evaluate(AUDIT_SOURCE) as {text:{fontSize:number;contrast:number;fontWeight:number}[]};
      expect(audit.text.filter(r=>r.fontSize>0&&r.fontSize<11)).toEqual([]);
      expect(audit.text.filter(r=>r.contrast<(r.fontSize>=24||r.fontWeight>=700&&r.fontSize>=18.66?3:4.5))).toEqual([]);
    }
    await expect(dialog.getByRole('button',{name:'开始处理',exact:true})).toBeEnabled();
    await page.screenshot({path:testInfo.outputPath(`inline-scope-${width}-${theme}.png`),fullPage:true,animations:'disabled'});
    await dialog.getByRole('button',{name:'开始处理',exact:true}).click();await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('button',{name:'重试原批次',exact:true}).click();await expect.poll(()=>bodies.length).toBe(3);
    expect(bodies[1]).toEqual(bodies[2]);expect(bodies[1]).toMatchObject({operation:'merge_and_publish',publish:true,scopeDigest:'reviewed-scope',selection:[{id:'pending',revision:'rev-pending'},{id:'merged',revision:'rev-merged'}]});
  });
}

test('AND-511 already merged selection offers publication only and blocks an unknown scope',async({page,request})=>{
  const product=await(await request.post('/api/v1/products',{data:{name:'Publish only',keyPrefix:'QPUB'}})).json();
  const row={id:'merged',productId:product.id,sessionId:'source',revision:'r',state:'merged',summary:'已合并交付',validation:'Synthetic',itemKeys:[],head:'a'.repeat(40),requiredArtifacts:['web'],pullRequestUrl:'https://github.com/example/project/pull/1',evidence:{checkedAt:'2026-11-12T00:00:00Z',source:'Fixture'},queue:{stage:'release',publishedArtifacts:[],pendingArtifacts:['web'],records:[]}};
  await page.route('**/integration-queue?**',route=>route.fulfill({json:{deliveries:[row],counts:{release:1}}}));
  await page.route(/\/merge-deliveries(?:\?.*)?$/,route=>route.fulfill({json:{deliveries:[],batches:[]}}));
  let recovered=false;
  await page.route('**/integration-preview',route=>route.fulfill({json:{digest:'scope',requiredArtifacts:['web'],candidates:[{identity:'delivery:merged',title:'已合并交付',selected:true,requiredArtifacts:['web']}],blockers:recovered?[]:['发布范围待核实']}}));
  await page.route('**/api/v1/nodes',route=>route.fulfill({json:{nodes:[{id:'node',name:'Fixture',online:true,supportsFreeSessions:true,agents:[{kind:'codex',planApprovalProtocol:1,ready:true,models:[]}],repos:[{productId:product.id,repoPath:'fixture'}],repoCandidates:[],createdAt:'2026-11-12T00:00:00Z'}]}}));
  for(const name of ['dispatch-defaults','integration-defaults'])await page.route('**/api/v1/'+name,route=>route.fulfill({json:{nodeId:'node',agentKind:'codex',agents:{codex:{mode:'auto'}}}}));
  await page.goto(`/?product=${product.id}&console=agent`);await page.getByRole('button',{name:'待集成 1',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.locator('.merge-row input').check();await dialog.getByRole('button',{name:'下一步：配置 Agent'}).click();
  await page.emulateMedia({reducedMotion:'reduce'});
  expect(await dialog.locator('.merge-configuration-step').evaluate(el=>getComputedStyle(el).animationName)).toBe('none');
  await expect(dialog.getByText('仅发布',{exact:true})).toBeVisible();await expect(dialog.getByRole('checkbox',{name:/合并后发布/})).toHaveCount(0);
  await expect(dialog.getByRole('button',{name:'开始处理',exact:true})).toBeDisabled();
  recovered=true;await dialog.getByRole('button',{name:'上一步',exact:true}).click();await dialog.getByRole('button',{name:'下一步：配置 Agent'}).click();
  await expect(dialog.getByRole('button',{name:'开始处理',exact:true})).toBeEnabled();
});

for(const width of [320,1440])for(const theme of ['light','dark'] as const) {
  test(`queue lifecycle review and history ${width} ${theme}`,async({page,request},testInfo)=>{
    await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
    const product=await(await request.post('/api/v1/products',{data:{name:`Lifecycle ${width} ${theme}`,keyPrefix:`L${width}${theme[0]!.toUpperCase()}`}})).json();
    const row=(id:string,stage:string,resolution?:string)=>({id,productId:product.id,sessionId:'source',revision:id,state:'merged',summary:id,itemKeys:[],head:'a'.repeat(40),validation:'Synthetic evidence',requiredArtifacts:['web'],pullRequestUrl:'https://github.com/example/project/pull/1',evidence:{checkedAt:'2026-11-12T00:00:00Z',source:'Fixture'},queue:{stage,resolution,publishedArtifacts:[],pendingArtifacts:['web'],records:[],...(stage==='review'?{blocker:'缺少本轮交付证据，请核对原交付。'}:{})}});
    await page.route(/\/merge-deliveries(?:\?.*)?$/,route=>route.fulfill({json:{deliveries:[],batches:[]}}));
    await page.route('**/integration-queue?**',route=>{
      const stage=new URL(route.request().url()).searchParams.get('stage');
      return route.fulfill({json:{deliveries:stage==='history'?[row('AND-435 historical','history','historical'),row('AND-450 no release','history','not_required')]:stage==='release'||stage==='merge'?[]:[row('Missing receipt','review')],counts:{review:1,history:2}}});
    });
    await page.goto(`/?product=${product.id}&console=agent`);
    await page.getByRole('button',{name:'待集成 0',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await expect(dialog.getByRole('button',{name:'全部 1',exact:true})).toBeVisible();
    await dialog.getByRole('button',{name:'待核对 1',exact:true}).click();
    await expect(dialog.locator('.merge-row input')).toBeDisabled();
    await expect(dialog.getByRole('button',{name:'全选可选内容',exact:true})).toBeDisabled();
    await expect(dialog.getByRole('button',{name:'下一步：配置 Agent',exact:true})).toBeDisabled();
    await dialog.getByRole('button',{name:'查看改动与验证详情',exact:true}).click();
    await expect(page.getByRole('dialog').last()).toContainText('Synthetic evidence');
    await page.keyboard.press('Escape');
    await dialog.getByRole('button',{name:'交付历史',exact:true}).click();
    const history=page.getByRole('dialog').last();
    await expect(history.getByText('历史轮次 · 后续已返工',{exact:true})).toBeVisible();
    await expect(history.getByText('无需发布／已交接',{exact:true})).toBeVisible();
    await expect(history.getByText('待发布产物: Web',{exact:true})).toHaveCount(0);
    await page.screenshot({path:testInfo.outputPath(`lifecycle-${width}-${theme}.png`),fullPage:true});
    await page.keyboard.press('Escape');
    await expect(dialog.getByRole('button',{name:'待核对 1',exact:true})).toHaveAttribute('aria-pressed','true');
    await page.evaluate(()=>document.documentElement.dataset.fontScale='large');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const audit=await page.evaluate(AUDIT_SOURCE) as {text:{fontSize:number;contrast:number;fontWeight:number}[]};
    expect(audit.text.filter(r=>r.fontSize>0&&r.fontSize<11)).toEqual([]);
    expect(audit.text.filter(r=>r.contrast<(r.fontSize>=24||r.fontWeight>=700&&r.fontSize>=18.66?3:4.5))).toEqual([]);
  });
}
