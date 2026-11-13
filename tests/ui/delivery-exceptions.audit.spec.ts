import {expect,test} from '@playwright/test';
import {AUDIT_SOURCE} from './audit-page.mjs';

for(const width of [320,1440])for(const theme of ['light','dark'] as const) {
  test(`delivery exception investigation and human closure ${width} ${theme}`,async({page,request},testInfo)=>{
    await page.clock.setFixedTime(new Date('2026-11-13T08:00:00Z'));
    await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme});
    const product=await(await request.post('/api/v1/products',{data:{name:`Exceptions ${width} ${theme}`,keyPrefix:`E${width}${theme[0]!.toUpperCase()}`}})).json();
    let started=false,closed=false,waiting=true,fresh=false,changedScope=false,contextFailure=false;const bodies:unknown[]=[];
    const row=()=>({latestInputAt:'2026-11-13T08:00:01Z',id:'exception',productId:product.id,sessionId:'source',revision:'r1',state:'merged',summary:'无需发布的旧交付',itemKeys:['AND-450'],head:'a'.repeat(40),validation:'已合并，人工早期记录不等于正式交接。',requiredArtifacts:[],noReleaseReason:'仅本机工具，无产品产物。',pullRequestUrl:'https://github.com/example/project/pull/1',evidence:{checkedAt:'2026-11-13T07:00:00Z',source:'Synthetic'},queue:{stage:'review',...(!closed?{blocker:'无需发布交接证据待核实。'}:{}),publishedArtifacts:[],pendingArtifacts:[],records:[],review:{scopeDigest:changedScope?'scope2':'scope1',...(started?{caseId:changedScope?'case2':'case1',sessionId:'investigation'}:{}),...(closed?{closedAt:'2026-11-13T08:00:00Z',closeNote:'确认本交付无需继续集成，保留缺少正式交接的事实。'}:{})}}});
    await page.route(/\/merge-deliveries(?:\?.*)?$/,route=>route.fulfill({json:{deliveries:[],batches:[]}}));
    await page.route('**/integration-queue?**',route=>{const stage=new URL(route.request().url()).searchParams.get('stage');return route.fulfill({json:{deliveries:stage==='review'&&!closed||stage==='reviewed'&&closed?[row()]:[],counts:{review:closed?0:1,history:closed?1:0}}});});
    await page.route('**/merge-deliveries/exception/review',route=>{
      if(route.request().method()==='GET')return route.fulfill(contextFailure?{status:503,json:{title:'Synthetic refresh unavailable'}}:{json:row()});
      bodies.push(route.request().postDataJSON());started=true;
      return route.fulfill({status:bodies.length===1?503:200,json:bodies.length===1?{title:'Synthetic acknowledgement lost'}:row()});
    });
    await page.route('**/merge-deliveries/exception/review/close',route=>{expect(route.request().postDataJSON()).toMatchObject({caseId:'case1',scopeDigest:'scope1',note:'确认本交付无需继续集成，保留缺少正式交接的事实。'});closed=true;return route.fulfill({json:row()});});
    await page.route('**/api/v1/agent-sessions/investigation?**',route=>route.fulfill({json:{id:'investigation',agentKind:'codex',status:'idle',messages:[{id:'answer',sourceId:'answer',role:'agent',text:'核查结果：无需发布产物，仍缺正式交接证据。请确认是否结束本条异常。',occurredAt:fresh?'2026-11-13T08:00:02Z':'2026-11-13T08:00:00Z'}],command:{kind:'interrupt',status:'delivered',createdAt:'2026-11-13T08:00:01.500Z'},activities:[],canReply:true,canResolveDelivery:false,turnState:{turnActive:false,waitingForInput:waiting}}}));
    await page.route('**/api/v1/nodes',route=>route.fulfill({json:{nodes:[{id:'node',name:'Fixture node',online:true,supportsFreeSessions:true,agents:[{kind:'codex',planApprovalProtocol:1,ready:true,models:[]}],repos:[{productId:product.id,repoPath:'fixture'}],repoCandidates:[],createdAt:'2026-11-13T07:00:00Z'}]}}));
    for(const suffix of ['dispatch-defaults','integration-defaults'])await page.route('**/api/v1/'+suffix,route=>route.fulfill({json:{nodeId:'node',agentKind:'codex',agents:{codex:{mode:'auto'}}}}));
    await page.goto(`/?product=${product.id}&console=agent`);
    await page.getByRole('button',{name:'待集成 0',exact:true}).click();
    const main=page.getByRole('dialog').last();await expect(main.getByRole('button',{name:'全部 0',exact:true})).toBeVisible();
    await expect(main.getByRole('button',{name:'待核对 1',exact:true})).toHaveCount(0);await expect(main.locator('.merge-row')).toHaveCount(0);
    await main.getByRole('button',{name:'交付异常 1',exact:true}).click();
    const exceptions=page.getByRole('dialog').last();await expect(exceptions.locator('input[type=checkbox]')).toHaveCount(0);
    await exceptions.getByRole('button',{name:'处理交付异常',exact:true}).click();
    const detail=page.getByRole('dialog').last();await expect(detail).toContainText('Agent 调查缺口并给出结论');
    await detail.getByRole('button',{name:'交给 Agent 核查',exact:true}).click();
    await page.getByRole('dialog').last().getByRole('button',{name:'进入会话',exact:true}).click();
    await expect(page.getByRole('dialog').last()).toContainText('结果尚未确认');
    await page.getByRole('dialog').last().getByRole('button',{name:'重试',exact:true}).click();
    await expect(detail.getByRole('heading',{name:'Agent 最新答复',exact:true})).toBeVisible();expect(bodies).toHaveLength(2);expect(bodies[0]).toEqual(bodies[1]);
    await expect(detail).toContainText('等待你的回复或决定');await expect(detail.getByText('记录结论并归入历史',{exact:true})).toHaveCount(0);
    waiting=false;await detail.getByRole('button',{name:'刷新核查结果',exact:true}).click();
    await expect(detail).toContainText('追问尚无新答复');await expect(detail.getByText('记录结论并归入历史',{exact:true})).toHaveCount(0);
    fresh=true;await detail.getByRole('button',{name:'刷新核查结果',exact:true}).click();
    await detail.getByRole('button',{name:'记录结论并归入历史',exact:true}).click();
    const conclusion=page.getByRole('dialog').last();
    await conclusion.getByRole('textbox',{name:'核查结论与处理理由'}).fill('确认本交付无需继续集成，保留缺少正式交接的事实。');
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'继续编辑',exact:true}).click();
    await expect(conclusion.getByRole('textbox',{name:'核查结论与处理理由'})).toHaveValue('确认本交付无需继续集成，保留缺少正式交接的事实。');
    for(const scale of ['small','medium','large']){
      await page.evaluate(v=>document.documentElement.dataset.fontScale=v,scale);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const audit=await page.evaluate(AUDIT_SOURCE) as {text:{fontSize:number}[]};expect(audit.text.filter(r=>r.fontSize>0&&r.fontSize<11)).toEqual([]);
    }
    const field=conclusion.getByRole('textbox',{name:'核查结论与处理理由'});
    const box=await field.boundingBox();expect(box).not.toBeNull();
    expect(await field.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height-4));})).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`exception-${width}-${theme}.png`),fullPage:true});
    contextFailure=true;
    await page.locator('dialog .merge-delivery-detail button').filter({hasText:'刷新核查结果'}).evaluate(el=>el.dispatchEvent(new MouseEvent('click',{bubbles:true})));
    await expect(conclusion.getByRole('button',{name:'重试',exact:true})).toBeVisible();
    await expect(conclusion.getByRole('button',{name:'确认归入历史',exact:true})).toBeDisabled();
    await expect(field).toHaveValue('确认本交付无需继续集成，保留缺少正式交接的事实。');
    contextFailure=false;await conclusion.getByRole('button',{name:'重试',exact:true}).click();
    await expect(conclusion.getByRole('button',{name:'确认归入历史',exact:true})).toBeEnabled();
    // Another device has created a completed investigation for a changed scope.
    changedScope=true;
    await page.locator('dialog .merge-delivery-detail button').filter({hasText:'刷新核查结果'}).evaluate(el=>el.dispatchEvent(new MouseEvent('click',{bubbles:true})));
    await expect(conclusion.getByRole('alert')).toContainText('变化');
    await expect(conclusion.getByRole('button',{name:'确认归入历史',exact:true})).toBeDisabled();
    await expect(field).toHaveValue('确认本交付无需继续集成，保留缺少正式交接的事实。');
    changedScope=false;
    await page.locator('dialog .merge-delivery-detail button').filter({hasText:'刷新核查结果'}).evaluate(el=>el.dispatchEvent(new MouseEvent('click',{bubbles:true})));
    await expect(conclusion.getByRole('button',{name:'确认归入历史',exact:true})).toBeEnabled();
    await conclusion.getByRole('button',{name:'确认归入历史',exact:true}).click();
    await expect(exceptions).toContainText('暂无未结束的交付异常');
    await page.keyboard.press('Escape');await expect(main.getByRole('button',{name:'全部 0',exact:true})).toBeVisible();
    await main.getByRole('button',{name:'交付历史',exact:true}).click();
    await expect(page.getByRole('dialog').last()).toContainText('核查已结束／不代表正式交接');
    await page.getByRole('dialog').last().getByText('查看改动与验证详情',{exact:true}).click();
    await expect(page.getByRole('dialog').last()).toContainText('确认本交付无需继续集成，保留缺少正式交接的事实。');
  });
}
