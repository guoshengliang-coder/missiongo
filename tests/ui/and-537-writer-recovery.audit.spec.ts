import {readFileSync} from "node:fs";
import {expect,test} from "@playwright/test";
import {queueRoute} from "./integration-queue-fixture";
const fixture=JSON.parse(readFileSync(new URL('./.auth/fixture.json',import.meta.url),'utf8')) as {productId:string;detailKey:string};
for(const surface of ['console','panel'] as const)for(const width of [320,1440])for(const appearance of ['light','dark'])test(`writer recovery ${surface} at ${width} ${appearance}`,async({page},info)=>{
 await page.emulateMedia({colorScheme:appearance as 'light'|'dark'});await page.setViewportSize({width,height:1000});
 const id='and-537-session',stamp=new Date().toISOString();let state:'occupied'|'ready'='occupied',checkedAt=stamp,sendCount=0,attachmentOk=false,supported=false,checkFailed=false;
 let command={id:'failed-reply',kind:'message',text:'合并和发布',status:'failed',createdAt:stamp,error:'回复未发送：Codex 拒绝 thread/resume: already has an active writer',attachments:[{id:'original-file',filename:'context.txt',kind:'document',contentType:'text/plain',sizeBytes:7}]};
 const summary={id,agentSessionId:id,dispatchId:'recovery-dispatch',agentKind:'codex',status:'idle',updatedAt:stamp,createdAt:stamp,nodeName:'Fixture',nodeId:'fixture-node',nodeConnectionState:'online',mode:'auto',dispatchStatus:'launched',activities:[],settings:{},unread:false,canReply:true,canRetry:false,canStop:false,canArchive:true,attention:{state:'needed',kind:'answer',reason:'待回答'},needsAttention:true,items:[{key:fixture.detailKey,title:'Recovery',productId:fixture.productId}]};
 await page.route('**/api/v1/agent-sessions**',async route=>{
  const url=new URL(route.request().url()),p=url.pathname;
  if(p.endsWith('/connection-check')){if(checkFailed)return queueRoute(route).fulfill({status:503,json:{title:'Check unavailable'}});checkedAt=new Date(Date.now()+1).toISOString();return queueRoute(route).fulfill({json:{supported,requestedAt:new Date().toISOString()}});}
  if(p.endsWith('/original-file/content'))return queueRoute(route).fulfill({status:attachmentOk?200:503,body:attachmentOk?'context':'Unavailable',contentType:'text/plain'});
  if(p.endsWith('/attachments')&&route.request().method()==='POST')return queueRoute(route).fulfill({json:{id:'reuploaded-file',filename:'context.txt',kind:'document',contentType:'text/plain',sizeBytes:7}});
  if(p.endsWith('/commands')&&route.request().method()==='POST'){
   sendCount++;const body=route.request().postDataJSON();expect(body.text).toBe('合并和发布');expect(body.attachmentIds).toEqual(['reuploaded-file']);
   command={...command,id:'retry-reply',status:'queued',error:'',createdAt:new Date().toISOString()};return queueRoute(route).fulfill({status:201,json:command});
  }
  return queueRoute(route).fulfill({json:p==='/api/v1/agent-sessions'?{sessions:[summary]}:{...summary,command,messages:[{id:'completed',sourceId:'completed',role:'agent',text:'本轮已结束。',occurredAt:stamp}],currentRequests:[],turnState:{turnActive:false,waitingForInput:false,replyReadiness:{state,checkedAt}}}});
 });
 await page.route('**/api/v1/items/*/dispatches',route=>queueRoute(route).fulfill({json:{dispatches:[{id:summary.dispatchId,agentSessionId:id,agentKind:'codex',mode:'auto',nodeName:'Fixture',status:'launched',createdAt:stamp,itemKeys:[fixture.detailKey]}]}}));
 await page.route(/\/(?:merge-deliveries|integration-queue)(?:\?.*)?$/,route=>queueRoute(route).fulfill({json:{deliveries:[],batches:[],sessionProgress:{}}}));
 if(surface==='console')await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
 else{await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);await page.locator('.execution-history > summary').click();await page.locator('.execution-record > summary').filter({hasText:'派单 · Fixture'}).click();await page.locator('.agent-session-toggle').click();}
 const card=page.locator('.agent-writer-recovery');await expect(card).toBeVisible();await expect(card).toContainText('另一个 Codex 进程');
 await expect(page.getByText('编辑后重试',{exact:true})).toHaveCount(0);await expect(page.locator('.agent-console-recovery')).toHaveCount(0);
 const draft=page.locator(surface==='console'?'.agent-console-reply textarea':'.agent-session-reply textarea');await draft.fill('保留当前草稿');
 await card.getByRole('button',{name:'恢复方法',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog).toContainText('有任务运行或无法确认时，先不要退出');
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();await expect(card.getByRole('button',{name:'恢复方法',exact:true})).toBeFocused();
 await card.getByRole('button',{name:'检查是否可继续',exact:true}).click();await expect(card).toContainText('当前节点尚不支持连接检查');expect(sendCount).toBe(0);
 supported=true;checkFailed=true;await card.getByRole('button',{name:'检查是否可继续',exact:true}).click();await expect(card).toContainText('连接检查失败');expect(sendCount).toBe(0);checkFailed=false;
 await card.getByRole('button',{name:'检查是否可继续',exact:true}).click();await expect(card).toContainText('会话仍被占用');expect(sendCount).toBe(0);await expect(draft).toHaveValue('保留当前草稿');
 await page.screenshot({path:info.outputPath(`occupied-${surface}-${width}.png`)});
 state='ready';await card.getByRole('button',{name:'检查是否可继续',exact:true}).click();await expect(card).toContainText('会话现已可继续');expect(sendCount).toBe(0);
 await card.getByRole('button',{name:'重试发送',exact:true}).click();await expect(card).toContainText('本次重试未能完成');expect(sendCount).toBe(0);await expect(draft).toHaveValue('保留当前草稿');
 attachmentOk=true;await card.getByRole('button',{name:'重试发送',exact:true}).click();await expect.poll(()=>sendCount).toBe(1);await expect(card).toHaveCount(0);await expect(draft).toHaveValue('保留当前草稿');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
