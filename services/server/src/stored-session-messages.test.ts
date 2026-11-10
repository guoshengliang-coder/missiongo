import { afterEach, expect, it, vi } from "vitest";
import { MissionGoStore } from "./store.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { AgentConsoleSessions } from "./agent-console-sessions.js";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";
import { StoredSessionMessages } from "./stored-session-messages.js";
const stores: MissionGoStore[]=[];
afterEach(()=>{stores.splice(0).forEach(store=>store.close());vi.restoreAllMocks();});
function fixture() {
  const store=new MissionGoStore(":memory:");stores.push(store);
  const db=store.database.connection,now=new Date().toISOString();
  const product=store.createProduct({name:"Synthetic",keyPrefix:"SY"});
  const item=store.createWorkItem({productId:product.id,title:"History",description:"",type:"task",priority:"normal"});
  store.transitionWorkItem({itemKey:item.key,to:"ready",reason:"triaged",actor:"human"});
  store.claimWorkItem({itemKey:item.key,agentId:"codex",idempotencyKey:"claim"});
  db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at)
    VALUES ('node','owner','synthetic','Synthetic','synthetic','[]',?,?,?)`).run(now,now,now);
  const dispatch=new AgentSessionStore(store.database),external=new ExternalAgentSessionStore(store);
  const create=(name:string,ref="thread")=>{
    db.prepare("INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at) VALUES (?,'owner','node','codex','default','launched','synthetic',?)").run(name,now);
    db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES (?,?,0)").run(name,item.id);
    return dispatch.createForDispatch({dispatchId:name,nodeId:"node",sessionRef:ref});
  };
  const id=create("dispatch");
  const console=new AgentConsoleSessions(store,dispatch,external),messages=new StoredSessionMessages(store.database);
  return {store,db,dispatch,external,console,messages,id,create,item,now};
}
it("matches complete mirror precedence and order across every page, including ties and unequal duplicate timestamps",()=>{
  const f=fixture();
  const native=f.external.register({accountId:"owner",clientId:"synthetic"},{agentKind:"codex",refKind:"native",sessionRef:"thread"},f.item.key);
  const mirrored=f.create("resumed");
  for(const id of [f.id,mirrored]) f.dispatch.recordSnapshot({nodeId:"node",sessionId:id,status:"idle",
    messages:Array.from({length:137},(_,n)=>({sourceId:`source-${n}`,role:"agent" as const,text:`${id===f.id?'requested':'mirror'}-${n}`,occurredAt:f.now}))});
  const write=f.db.prepare("INSERT INTO external_native_messages(id,session_id,source_id,payload_json,position) VALUES (?,?,?,?,?)");
  for(let n=0;n<190;n++) write.run(`external-${n}`,native,`source-${n}`,JSON.stringify({sourceId:`source-${n}`,role:"agent",text:`external-${n}`,occurredAt:n<137?"2099-01-01T00:00:00.000Z":f.now}),n);
  for(const id of [f.id,native,mirrored]) {
    const group=f.console.members("owner",id);
    const full=f.console.withMessages("owner",id,id===native?f.external.getForAccount("owner",id):f.dispatch.getForAccount("owner",id),group).messages;
    let cursor:string|undefined,all: typeof full=[];let pages=0;
    do {const page=f.messages.page(id,group,cursor);all.unshift(...page.messages);cursor=page.nextCursor;expect(++pages).toBeLessThan(10);}while(cursor);
    expect(all).toEqual(full);
  }
});
it("retains solo position/observation ordering and existing cursors after append, and rejects foreign anchors",()=>{
  const f=fixture();
  f.dispatch.recordSnapshot({nodeId:"node",sessionId:f.id,status:"idle",messages:Array.from({length:123},(_,n)=>({sourceId:`m-${n}`,role:"agent" as const,text:`message-${n}`,occurredAt:n%2?"2025-01-01T00:00:00.000Z":"2024-01-01T00:00:00.000Z"}))});
  const group=f.console.members("owner",f.id),full=f.dispatch.getForAccount("owner",f.id).messages;
  const recent=f.messages.page(f.id,group);expect(recent.messages).toEqual(full.slice(-50));
  const middle=f.messages.page(f.id,group,recent.nextCursor);expect(middle.messages).toEqual(full.slice(23,73));
  f.dispatch.recordSnapshot({nodeId:"node",sessionId:f.id,status:"idle",messages:[{sourceId:"new",role:"agent",text:"Newest"}]});
  expect(f.messages.page(f.id,group,recent.nextCursor)).toEqual(middle);
  const other=f.create("other","other-thread");
  expect(()=>f.messages.page(other,f.console.members("owner",other),recent.nextCursor)).toThrow(/anchor/);
  expect(()=>f.messages.page(f.id,group,"made-up")).toThrow(/cursor/);
});
it("bounds fetched message bodies and preserves a single oversized UTF-8 message without truncation",()=>{
  const f=fixture();
  const write=f.db.prepare("INSERT INTO agent_session_messages(id,session_id,source_id,role,text,position,observed_at,occurred_at) VALUES (?,?,?,'agent',?,?,?,?)");
  f.store.database.transaction(()=>{for(let n=0;n<10000;n++)write.run(`m-${n}`,f.id,`m-${n}`,n===9999?"汉".repeat(200000):"x".repeat(1024),n,f.now,f.now);});
  const group=f.console.members("owner",f.id);let bodies=0;
  const prepare=f.db.prepare.bind(f.db);
  vi.spyOn(f.db,"prepare").mockImplementation(sql=>{
    const stmt=prepare(sql);
    if(sql.includes("turn_id,role,phase,text,questions_json")) {
      const get=stmt.get.bind(stmt);vi.spyOn(stmt,"get").mockImplementation((...args)=>{const row=get(...args);if(row)bodies++;return row;});
    }
    return stmt;
  });
  const recent=f.messages.page(f.id,group);
  expect(recent.messages).toHaveLength(1);expect(recent.messages[0]!.text).toHaveLength(200000);
  expect(bodies).toBe(2);
  expect(f.messages.page(f.id,group,recent.nextCursor).messages).toHaveLength(50);
});
it("reads current questions and plan/user context outside the recent page without reviving a stale lower-priority request",()=>{
  const f=fixture();
  const requests=[{sourceId:"permission",role:"agent" as const,text:"Allow?",questions:[{title:"Allow",options:["Yes","No"],key:"授权请求 one"}]}];
  f.dispatch.recordSnapshot({nodeId:"node",sessionId:f.id,status:"idle",messages:[...requests,{sourceId:"plan",role:"plan",text:"Original plan"},{sourceId:"answer",role:"user",text:"New requirement"},...Array.from({length:100},(_,n)=>({sourceId:`tail-${n}`,role:"agent" as const,text:"Tail"}))]});
  const group=f.console.members("owner",f.id);
  expect(f.messages.page(f.id,group).messages.some(message=>message.sourceId==="permission")).toBe(false);
  expect(f.messages.currentRequests(f.id,group)).toMatchObject([{sourceId:"permission"}]);
  expect(f.messages.context(f.id,group,"plan").map(message=>message.sourceId)).toEqual(["plan","answer","tail-99"]);
  const native=f.external.register({accountId:"owner",clientId:"synthetic"},{agentKind:"codex",refKind:"native",sessionRef:"thread"},f.item.key);
  f.db.prepare("INSERT INTO external_native_messages(id,session_id,source_id,payload_json,position) VALUES ('mirror-request',?,'permission',?,0)").run(native,JSON.stringify(requests[0]));
  f.dispatch.recordSnapshot({nodeId:"node",sessionId:f.id,status:"idle",messages:[{...requests[0]!,questions:[{...requests[0]!.questions[0]!,withdrawn:true}]}]});
  expect(f.messages.currentRequests(f.id,f.console.members("owner",f.id))).toEqual([]);
});

it("paginates external progress reports independently without losing records or accepting another conversation's cursor",()=>{
  const f=fixture();
  const native=f.external.register({accountId:"owner",clientId:"synthetic"},{agentKind:"codex",refKind:"native",sessionRef:"thread"},f.item.key);
  const insert=f.db.prepare(`INSERT INTO external_agent_session_reports(id,session_id,item_key,status,text,idempotency_key,digest,created_at)
    VALUES (?,?,?,'working',?,?,?,?)`);
  f.store.database.transaction(()=>{for(let n=0;n<1000;n++)insert.run(`report-${n}`,native,f.item.key,`Progress ${n}`,`report-${n}`,`synthetic-${n}`,f.now);});
  const group=f.console.members("owner",f.id),recent=f.messages.reports(f.id,group);
  const full=f.external.getForAccount("owner",native).progressReports!;
  expect(recent.progressReports).toHaveLength(50);expect(recent.progressReports).toEqual(full.slice(-50));
  expect(f.external.getForAccount("owner",native,false).progressReports).toHaveLength(1);
  let cursor=recent.nextCursor;const ids=recent.progressReports.map(report=>report.id);
  while(cursor){const page=f.messages.reports(f.id,group,cursor);ids.unshift(...page.progressReports.map(report=>report.id));cursor=page.nextCursor;}
  expect(ids).toEqual(full.map(report=>report.id));
  expect(ids.filter(id=>id.startsWith("report-"))).toHaveLength(1000);
  const other=f.create("other-progress","another-thread");
  expect(()=>f.messages.reports(other,f.console.members("owner",other),recent.nextCursor)).toThrow(/anchor/);
});

it("keeps long-lived native identities readable beyond SQLite's compound-select limit",()=>{
  const f=fixture();
  f.dispatch.recordSnapshot({nodeId:"node",sessionId:f.id,status:"idle",messages:Array.from({length:123},(_,n)=>({sourceId:`one-${n}`,role:"agent" as const,text:`Original source ${n}`}))});
  for(let n=0;n<501;n++)f.create(`history-round-${n}`);
  const group=f.console.members("owner",f.id);
  expect(group).toHaveLength(502);
  const recent=f.messages.page(f.id,group);
  const middle=f.messages.page(f.id,group,recent.nextCursor);
  const oldest=f.messages.page(f.id,group,middle.nextCursor);
  expect([...oldest.messages,...middle.messages,...recent.messages]).toEqual(f.dispatch.getForAccount("owner",f.id).messages);
  expect(oldest.nextCursor).toBeUndefined();
});

it("matches full-history precedence and current forms across the large mixed-source query path",()=>{
  const f=fixture();
  const native=f.external.register({accountId:"owner",clientId:"audit-large"},{agentKind:"codex",refKind:"native",sessionRef:"thread"},f.item.key);
  let resumed=f.id;
  for(let n=0;n<100;n++)resumed=f.create(`large-round-${n}`);
  const question={title:"Still open",options:["Continue"],key:"large-question"};
  for(const id of [f.id,resumed])f.dispatch.recordSnapshot({nodeId:"node",sessionId:id,status:"idle",messages:[
    {sourceId:"request",role:"agent",text:"Authoritative closed form",questions:[{...question,withdrawn:true}]},
    ...Array.from({length:123},(_,n)=>({sourceId:`mixed-${n}`,role:"agent" as const,text:`${id}-${n}`,occurredAt:n%2?f.now:"2025-01-01T00:00:00.000Z"})),
  ]});
  const insert=f.db.prepare("INSERT INTO external_native_messages(id,session_id,source_id,payload_json,position) VALUES (?,?,?,?,?)");
  insert.run("large-request",native,"request",JSON.stringify({sourceId:"request",role:"agent",text:"Mirror open form",questions:[question]}),0);
  for(let n=0;n<160;n++)insert.run(`large-external-${n}`,native,`mixed-${n}`,JSON.stringify({sourceId:`mixed-${n}`,role:"agent",text:`External ${n}`,occurredAt:n%3?f.now:"2099-01-01T00:00:00.000Z"}),n+1);
  for(const id of [f.id,native,resumed]){
    const group=f.console.members("owner",id);
    expect(group.length).toBeGreaterThan(100);
    const snapshot=id===native?f.external.getForAccount("owner",id):f.dispatch.getForAccount("owner",id);
    const expected=f.console.withMessages("owner",id,snapshot,group).messages;
    let cursor:string|undefined,pages=0;const all:typeof expected=[];
    do{const page=f.messages.page(id,group,cursor);all.unshift(...page.messages);cursor=page.nextCursor;expect(++pages).toBeLessThan(10);}while(cursor);
    expect(all).toEqual(expected);
    expect(f.messages.currentRequests(id,group)).toEqual(id===native?[expected.find(message=>message.sourceId==="request")!]:[]);
  }
});
