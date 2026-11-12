import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string};
for (const width of [390,1440]) test.describe(`${width}px common instructions`,()=>{
 test.use({viewport:{width,height:900},hasTouch:width===390,isMobile:width===390});
 test("creates from a message, inserts without sending and returns from unified settings with the draft",async({page,request},testInfo)=>{
  await page.clock.setFixedTime(new Date("2026-11-12T03:00:00Z"));
  const id=`commands-${width}`,stamp="2026-11-12T02:00:00Z";
  const session={id,agentSessionId:id,dispatchId:id,productId:fixture.productId,agentKind:"codex",status:"idle",dispatchStatus:"launched",sessionName:"常用指令测试",nodeName:"Fixture",nodeConnectionState:"online",nodeRevoked:false,mode:"auto",createdAt:stamp,updatedAt:stamp,activityAt:stamp,items:[],canReply:true,canAttach:false,canRetry:false,canStop:false,canArchive:true,unread:false,settings:{adjustable:false},attention:{state:"not_needed"},needsAttention:false,waitingForReply:false,activities:[],turnState:{turnActive:false}};
  const second={...session,id:id+"-second",agentSessionId:id+"-second",dispatchId:id+"-second",sessionName:"另一个会话"};
  let sends=0;
  await page.route("**/api/v1/agent-sessions**",route=>{if(route.request().method()!=="GET"){sends++;return route.fulfill({status:204})}return route.fulfill({json:new URL(route.request().url()).pathname==="/api/v1/agent-sessions"?{sessions:[session,second]}:{...(route.request().url().includes(second.id)?second:session),messages:[{id:"user",sourceId:"user",role:"user",text:`先调查，暂不动工 ${width}`,occurredAt:stamp}]}})});
  await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
  const draft=page.locator('.agent-console-reply textarea');
  if(width===1440){await page.locator('.agent-console-session').filter({hasText:'另一个会话'}).click();await draft.fill(`保留原草稿\n先调查，暂不动工 ${width}`);await page.locator('.agent-console-session').filter({hasText:'常用指令测试'}).click()}
  await draft.fill("保留原草稿");
  const more=page.locator('.common-command-message-menu summary');if(width===1440)await page.locator('.agent-console-message-user').hover();if(width===390){const box=await more.boundingBox();expect(box!.width).toBeGreaterThanOrEqual(44);expect(box!.height).toBeGreaterThanOrEqual(44);expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width);}
  if(width===390)expect(await page.locator('.agent-console-message-user .markdown-text').evaluate(el=>{const text=el.querySelector('p')!.firstChild!;const range=document.createRange();range.setStart(text,text.textContent!.length-1);range.setEnd(text,text.textContent!.length);const r=range.getBoundingClientRect();return [1,3,5].every(d=>Boolean(document.elementFromPoint(r.x+r.width/2,r.y+d)?.closest('.markdown-text')))})).toBe(true);
  await more.click();
  await page.getByRole('button',{name:'保存为常用指令',exact:true}).filter({visible:true}).click();
  await expect(page.getByRole('dialog').getByRole('textbox',{name:'指令内容',exact:true})).toHaveValue(`先调查，暂不动工 ${width}`);
  await page.getByRole('button',{name:'保存指令',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(draft).toHaveValue('保留原草稿');
  await page.locator('.common-command-add summary').click();await page.getByRole('button',{name:'常用指令',exact:true}).click();
  const picker=page.getByRole('dialog');await picker.getByRole('textbox',{name:'搜索指令内容'}).fill(`暂不动工 ${width}`);
  await expect(picker.locator('.common-command-choice')).toHaveCount(1);
  await picker.getByRole('button',{name:'管理指令',exact:true}).click();
  await expect(page).toHaveURL(/\/settings\/common-commands/);await expect(page.locator('.settings-page input')).toHaveCount(0);
  const managed=page.locator('.account-row').filter({hasText:`先调查，暂不动工 ${width}`});await managed.getByRole('button',{name:'收藏指令',exact:true}).click();await expect(managed.getByRole('button',{name:'取消收藏',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.screenshot({path:testInfo.outputPath('settings.png')});
  await page.locator('.settings-page-header button').click();
  await expect(page.getByRole('dialog').getByRole('textbox',{name:'搜索指令内容'})).toHaveValue(`暂不动工 ${width}`);
  await page.getByRole('dialog').locator('.common-command-choice').click();await expect(draft).toHaveValue(`保留原草稿\n先调查，暂不动工 ${width}`);
  if(width===1440){await page.locator('.agent-console-session').filter({hasText:'另一个会话'}).click();await expect(draft).toHaveValue(`保留原草稿\n先调查，暂不动工 ${width}`);await expect(page.getByRole('button',{name:'撤销',exact:true})).toHaveCount(0);await page.locator('.agent-console-session').filter({hasText:'常用指令测试'}).click()}
  expect(sends).toBe(0);await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(draft).toHaveValue('保留原草稿');
  await page.screenshot({path:testInfo.outputPath('chat.png')});
  // The two browser contexts share the account's persisted collection, not a product-scoped list.
  const response=await request.get('/api/v1/common-commands');expect(response.ok()).toBe(true);const state=await response.json();expect(state.commands.some((c:{content:string})=>c.content===`先调查，暂不动工 ${width}`)).toBe(true);
  const write=await request.post('/api/v1/common-commands',{data:{requestId:randomUUID(),revision:state.revision,action:{kind:'favorite',id:state.commands.at(-1).id,favorite:true}}});expect(write.ok()).toBe(true);
 });
});

test("account collection syncs through config events and stale writes preserve the latest data",async({page,context,request})=>{
 await page.clock.setFixedTime(new Date("2026-11-12T03:00:00Z"));
 await page.goto('/settings/common-commands');
 const state=await (await request.get('/api/v1/common-commands')).json();
 const unique=`同步验证 ${randomUUID()}`;
 const before=await request.post('/api/v1/common-commands',{data:{requestId:randomUUID(),revision:state.revision,action:{kind:'create',content:unique,name:'',favorite:false}}});expect(before.ok()).toBe(true);
 await expect(page.locator('.common-command-text').filter({hasText:unique})).toBeVisible();
 const stale=await request.post('/api/v1/common-commands',{data:{requestId:randomUUID(),revision:state.revision,action:{kind:'create',content:'stale',name:'',favorite:false}}});expect(stale.status()).toBe(409);
 const second=await context.newPage();await second.goto('/settings/common-commands');await expect(second.locator('.common-command-text').filter({hasText:unique})).toBeVisible();await second.close();
});

test("failed response retries the same create and concurrent edits require review",async({page,request})=>{
 await page.clock.setFixedTime(new Date('2026-11-12T03:00:00Z'));
 await page.goto('/settings/common-commands');await page.locator('.common-command-management').waitFor();
 let lose=true;const keys:string[]=[];
 await page.route('**/api/v1/common-commands',async route=>{
  if(route.request().method()!=='POST')return route.continue();
  const input=route.request().postDataJSON();keys.push(input.requestId);
  if(lose&&input.action.kind==='create'){lose=false;await route.fetch();return route.abort('failed')}
  return route.continue();
 });
 await page.getByRole('button',{name:'新建指令',exact:true}).click();
 const text=`幂等保存 ${randomUUID()}`;await page.getByRole('dialog').getByRole('textbox',{name:'指令内容',exact:true}).fill(text);
 await page.getByRole('button',{name:'保存指令',exact:true}).click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('操作未能保存');
 await page.getByRole('button',{name:'保存指令',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(keys[0]).toBe(keys[1]);
 const state=await (await request.get('/api/v1/common-commands')).json();const rows=state.commands.filter((c:{content:string})=>c.content===text);expect(rows).toHaveLength(1);
 await page.locator('.account-row').filter({hasText:text}).getByRole('button',{name:'编辑指令',exact:true}).click();
 await page.getByRole('dialog').getByRole('textbox',{name:'指令内容',exact:true}).fill('保留这份本地修改');
 const changed=await request.post('/api/v1/common-commands',{data:{requestId:randomUUID(),revision:state.revision,action:{kind:'edit',id:rows[0].id,content:'另一台设备的最新版本',name:'',favorite:false}}});expect(changed.ok()).toBe(true);
 await page.getByRole('button',{name:'保存指令',exact:true}).click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('其他设备');
 await expect(page.getByRole('dialog').getByText('另一台设备的最新版本',{exact:true})).toBeVisible();
 await expect(page.getByRole('dialog').getByRole('textbox',{name:'指令内容',exact:true})).toHaveValue('保留这份本地修改');
 // Explicit retry after showing the latest version is a new reviewed operation.
 await page.getByRole('button',{name:'保存指令',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
});

test("item panel restores its open ancestors and unsent draft after instruction settings",async({page})=>{
 await page.clock.setFixedTime(new Date('2026-11-12T03:00:00Z'));
 const id='common-command-panel',stamp='2026-11-12T02:00:00Z';
 let insertedDispatch=false;
 const option='本会话内允许（本会话，建议 1）';const question={header:'授权请求',key:'授权请求 request-1',title:'Claude Code 请求使用 Edit',options:['批准',option,'拒绝'],detail:option+'：'+JSON.stringify({type:'setMode',mode:'acceptEdits',destination:'session'})};const wire='授权请求 request-1: '+option;
 const row={id,agentSessionId:id,dispatchId:'panel-dispatch',agentKind:'codex',status:'idle',mode:'auto',dispatchStatus:'launched',nodeName:'Fixture',createdAt:stamp,updatedAt:stamp,activityAt:stamp,activities:[],items:[{key:fixture.detailKey,productId:fixture.productId,title:'Fixture'}],settings:{mode:'auto',adjustable:false},canReply:true,canArchive:true,canStop:false,canRetry:false,attention:{state:'not_needed'}};
 await page.route('**/api/v1/agent-sessions**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/api/v1/agent-sessions'?{sessions:[row]}:{...row,currentRequests:[{id:'question',role:'agent',questions:[question],text:'',occurredAt:stamp}],messages:[{id:'answer',role:'user',text:wire,occurredAt:stamp}]}}));
 await page.route('**/api/v1/items/*/dispatches',route=>route.fulfill({json:{dispatches:[...(insertedDispatch?[{id:'new-dispatch',agentKind:'codex',mode:'auto',nodeName:'新插入记录',status:'failed',createdAt:'2026-11-12T03:00:10Z',itemKeys:[fixture.detailKey]}]:[]),{id:row.dispatchId,agentSessionId:id,agentKind:'codex',mode:'auto',nodeName:'Fixture',status:'launched',createdAt:stamp,itemKeys:[fixture.detailKey]}]}}));
 await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
 await page.locator('.execution-history > summary').click();await page.locator('.execution-record > summary').filter({hasText:'派单 · Fixture'}).click();await page.locator('.agent-session-toggle').click();
 const shown=await page.locator('.agent-session-message-user .markdown-text').innerText();expect(shown).toContain('本次会话修改文件不再询问');await page.locator('.agent-session-message-user').hover();await page.locator('.agent-session-message-user .common-command-message-menu summary').click();await page.getByRole('button',{name:'保存为常用指令',exact:true}).filter({visible:true}).click();await expect(page.getByRole('dialog').getByRole('textbox',{name:'指令内容',exact:true})).toHaveValue(shown);await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
 const draft=page.locator('.agent-session-reply textarea');await draft.fill('面板草稿需要保留');await page.locator('.agent-session-reply .common-command-add summary').click();await page.getByRole('button',{name:'常用指令',exact:true}).click();await page.getByRole('button',{name:'管理指令',exact:true}).click();
 await expect(page).toHaveURL(/\/settings\/common-commands/);insertedDispatch=true;await page.clock.setFixedTime(new Date('2026-11-12T03:00:20Z'));await page.locator('.settings-page-header button').click();await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();await expect(page.locator('.execution-record > summary').filter({hasText:'新插入记录'})).toHaveCount(1);await expect(draft).toBeVisible();await expect(draft).toHaveValue('面板草稿需要保留');
});

for(const width of [320,1440]) for(const theme of ['light','dark'] as const) test(`instruction settings and picker stay usable ${width} ${theme}`,async({page,request},testInfo)=>{
 await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});await page.clock.setFixedTime(new Date('2026-11-12T03:00:00Z'));
 const current=await (await request.get('/api/v1/common-commands')).json();if(!current.commands.length){await request.post('/api/v1/common-commands',{data:{requestId:randomUUID(),revision:current.revision,action:{kind:'create',content:'检查窄屏与深色下的指令管理。',name:'',favorite:true}}})}
 await page.goto('/settings/common-commands');await expect(page.locator('.common-command-tools').first()).toBeVisible();
 for(const scale of ['small','medium','large']){await page.evaluate(s=>{document.documentElement.dataset.fontScale=s;document.documentElement.dataset.consoleFontScale=s},scale);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const newButton=page.getByRole('button',{name:'新建指令',exact:true});await expect(newButton).toBeInViewport();await newButton.click();await expect(page.getByRole('dialog').getByRole('button',{name:'保存指令',exact:true})).toBeInViewport();await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();}
 await page.screenshot({path:testInfo.outputPath('settings-appearance.png')});
});


test("editor retries an initial read without losing message content",async({page})=>{
 await page.clock.setFixedTime(new Date('2026-11-12T03:00:00Z'));
 let fail=true;await page.route('**/api/v1/common-commands',route=>{if(fail&&route.request().method()==='GET'){return route.abort('failed')}return route.continue()});
 await page.goto('/settings/common-commands');await page.getByRole('button',{name:'新建指令',exact:true}).click();
 const dialog=page.getByRole('dialog');const text=dialog.getByRole('textbox',{name:'指令内容',exact:true});await text.fill('读取失败后保留此输入');
 await expect(dialog.getByText('常用指令加载失败。',{exact:true})).toBeVisible();fail=false;await dialog.getByRole('button',{name:'重试',exact:true}).click();
 await expect(dialog.getByText('常用指令加载失败。',{exact:true})).toHaveCount(0);await expect(text).toHaveValue('读取失败后保留此输入');await expect(dialog.getByRole('button',{name:'保存指令',exact:true})).toBeEnabled();
});

test("late save response does not roll back a newer synced collection",async({page,request})=>{
 await page.clock.setFixedTime(new Date('2026-11-12T03:00:00Z'));
 await page.goto('/settings/common-commands');await page.locator('.common-command-management').waitFor();
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});let saved:any;
 await page.route('**/api/v1/common-commands',async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();saved=await response.json();await gate;return route.fulfill({response})});
 await page.getByRole('button',{name:'新建指令',exact:true}).click();await page.getByRole('dialog').getByRole('textbox',{name:'指令内容',exact:true}).fill('等待响应的保存');await page.getByRole('button',{name:'保存指令',exact:true}).click();
 try{await expect.poll(()=>saved?.revision).toBeTruthy();const latest='较新的同步内容 '+randomUUID();const result=await request.post('/api/v1/common-commands',{data:{requestId:randomUUID(),revision:saved.revision,action:{kind:'create',content:latest,name:'',favorite:false}}});expect(result.ok()).toBe(true);await expect(page.locator('.common-command-management')).toContainText(latest);release();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('.common-command-management')).toContainText(latest)}finally{release()}
});


test("delete conflicts require reopening and reviewing the changed instruction",async({page,request})=>{
 await page.clock.setFixedTime(new Date('2026-11-12T03:00:00Z'));
 const state=await (await request.get('/api/v1/common-commands')).json();const content='待删除 '+randomUUID();const saved=await (await request.post('/api/v1/common-commands',{data:{requestId:randomUUID(),revision:state.revision,action:{kind:'create',content,name:'',favorite:false}}})).json();const command=saved.commands.find((c:{content:string})=>c.content===content);
 await page.goto('/settings/common-commands');await page.locator('.account-row').filter({hasText:content}).getByRole('button',{name:'删除指令？',exact:true}).click();
 const changed=content+' 其他设备修改';expect((await request.post('/api/v1/common-commands',{data:{requestId:randomUUID(),revision:saved.revision,action:{kind:'edit',id:command.id,content:changed,name:'',favorite:false}}})).ok()).toBe(true);
 const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'删除',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('重新选择并核对');await expect(dialog.getByRole('button',{name:'删除',exact:true})).toBeDisabled();
 await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('.account-row').filter({hasText:changed})).toBeVisible();await page.locator('.account-row').filter({hasText:changed}).getByRole('button',{name:'删除指令？',exact:true}).click();await dialog.getByRole('button',{name:'删除',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(page.locator('.account-row').filter({hasText:changed})).toHaveCount(0);
});
