import {scryptSync} from "node:crypto";
import {afterEach, expect, it} from "vitest";
import {buildApp} from "./app.js";
import {AgentSessionStore} from "./agent-session-store.js";
import {mergeSessionHealth, executionTurnState} from "./agent-session-health.js";
const apps: ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
async function fixture(){
 const salt=Buffer.from("synthetic-recovery-salt");
 const app=buildApp({adminAccount:{id:"owner",username:"owner@example.test",sessionSecret:"synthetic-recovery-session-secret",cookieSecure:false,passwordScrypt:`scrypt:${salt.toString("base64url")}:${scryptSync("password",salt,64).toString("base64url")}`}});apps.push(app);
 const login=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:"owner@example.test",password:"password"}});
 const headers={cookie:login.headers["set-cookie"]!.split(";",1)[0]!};
 const store=app.missionGoStore,db=store.database.connection,now=new Date().toISOString();
 const product=store.createProduct({name:"Example",keyPrefix:"EX"});
 const item=store.createWorkItem({productId:product.id,title:"Recovery",description:"",type:"bug",priority:"normal",environment:{platform:"web"}});
 store.transitionWorkItem({itemKey:item.key,to:"ready",reason:"triaged",actor:"human"});
 store.claimWorkItem({itemKey:item.key,agentId:"codex",idempotencyKey:"claim"});
 db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at) VALUES ('node','owner','fixture','Fixture','synthetic','[]',?,?,?)`).run(now,now,now);
 db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at) VALUES ('dispatch','owner','node','codex','default','launched','synthetic-repo',?)`).run(now);
 db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('dispatch',?,0)").run(item.id);
 const sessions=new AgentSessionStore(store.database),id=sessions.createForDispatch({dispatchId:"dispatch",nodeId:"node",sessionRef:"thread"});
 const snapshot=(turnState: Parameters<AgentSessionStore["recordSnapshot"]>[0]["turnState"])=>sessions.recordSnapshot({nodeId:"node",sessionId:id,status:"idle",messages:[],turnState});snapshot({turnActive:false});
 return {app,headers,id,db,sessions,snapshot};
}
it("connection check queues only an observation, leaves commands, ordering, settings and item state alone",async()=>{
 const f=await fixture();const before=f.sessions.getForAccount("owner",f.id);
 const response=await f.app.inject({method:"POST",url:`/api/v1/agent-sessions/${f.id}/connection-check`,headers:f.headers,payload:{}});
 expect(response.statusCode,response.body).toBe(200);expect(response.json().supported).toBe(false);
 const after=f.sessions.getForAccount("owner",f.id);
 expect(after.command).toEqual(before.command);expect(after.status).toBe(before.status);expect(after.updatedAt).toBe(before.updatedAt);
 expect(after.turnState.connectionCheckRequestedAt).toBe(response.json().requestedAt);
 expect(f.db.prepare("SELECT count(*) AS n FROM agent_session_commands").get()).toMatchObject({n:0});
 expect(f.sessions.listForNode("node").some(s=>s.id===f.id)).toBe(true);
});
it("fresh source readiness is returned separately from historical send failures",async()=>{
 const f=await fixture();f.snapshot({turnActive:false,replyReadiness:{state:"occupied",checkedAt:new Date().toISOString()}});
 const check=await f.app.inject({method:"POST",url:`/api/v1/agent-sessions/${f.id}/connection-check`,headers:f.headers,payload:{}});
 expect(check.json().supported).toBe(true);
 const requestedAt=check.json().requestedAt;
 f.snapshot({turnActive:false,replyReadiness:{state:"ready",checkedAt:requestedAt}});
 const result=await f.app.inject({url:`/api/v1/agent-sessions/${f.id}?history=recent`,headers:f.headers});
 expect(result.statusCode,result.body).toBe(200);expect(result.json().turnState.replyReadiness).toEqual({state:"ready",checkedAt:requestedAt});
 expect(result.json().command).toBeUndefined();expect(result.json().turnState.connectionCheckRequestedAt).toBe(requestedAt);
});
it("connection checks require authentication and cannot target an archived session",async()=>{
 const f=await fixture();const url=`/api/v1/agent-sessions/${f.id}/connection-check`;
 expect((await f.app.inject({method:"POST",url,payload:{}})).statusCode).toBe(401);
 f.db.prepare("UPDATE agent_sessions SET archived_at=? WHERE id=?").run(new Date().toISOString(),f.id);
 expect((await f.app.inject({method:"POST",url,headers:f.headers,payload:{}})).statusCode).toBeGreaterThanOrEqual(400);
});
it("source cannot forge the request clock and observations do not create execution activity",()=>{
 const requested="2026-11-22T00:00:00Z",checked="2026-11-22T00:00:01Z";
 const next=mergeSessionHealth("idle",{connectionCheckRequestedAt:requested},"idle",{connectionCheckRequestedAt:checked,replyReadiness:{state:"ready",checkedAt:checked}}).turnState;
 expect(next.connectionCheckRequestedAt).toBe(requested);expect(next.replyReadiness?.state).toBe("ready");expect(executionTurnState(next)).toEqual({});
});
