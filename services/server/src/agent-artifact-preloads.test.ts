import { scryptSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it } from "vitest";
import { buildApp } from "./app.js";
import { DispatchStore } from "./dispatch-store.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";
import { ExternalNativeSessionStore } from "./external-native-session-store.js";

it.each(["dispatch","project","external"])("prepares %s output without a detail read, shares copies with proven mirrors, and preserves read/access boundaries",async kind=>{
  const root=await mkdtemp(join(tmpdir(),"artifact-preload-")),salt=Buffer.from("artifact-test-salt");
  const app=buildApp({databasePath:join(root,"db.sqlite"),attachmentsPath:join(root,"files"),adminAccount:{
    id:"owner",username:"owner@example.test",passwordScrypt:`scrypt:${salt.toString("base64url")}:${scryptSync("fixture-password",salt,64).toString("base64url")}`,
    sessionSecret:"synthetic-artifact-route-session-secret",cookieSecure:false}});
  try {
    const store=app.missionGoStore,db=store.database.connection;
    const product=store.createProduct({name:"Fixture",keyPrefix:"PRE"});
    const item=store.createWorkItem({productId:product.id,title:"Fixture",description:"",type:"task",priority:"normal",environment:{platform:"web"}});
    const nodes=new DispatchStore(store.database),node=nodes.registerNode({accountId:"owner",name:"Fixture",installationId:"preload-fixture"});
    db.prepare("UPDATE nodes SET agents_json=? WHERE id=?").run(JSON.stringify([{kind:"codex"}]),node.nodeId);
    const sessions=new AgentSessionStore(store.database);
    const now=new Date().toISOString();
    const create=(dispatchId:string)=>{
      db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at) VALUES (?,'owner',?,'codex','default','launched','synthetic',?)`).run(dispatchId,node.nodeId,now);
      db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES (?,?,0)").run(dispatchId,item.id);
      return sessions.createForDispatch({dispatchId,nodeId:node.nodeId,sessionRef:"same-native-thread"});
    };
    let id:string;
    let snapshotHeaders:Record<string,string>={authorization:`Bearer ${node.token}`};
    if(kind==="external") {
      const external=new ExternalAgentSessionStore(store);
      id=external.registerProject({accountId:"owner",clientId:"client"},{agentKind:"codex",sessionRef:"external-thread",refKind:"native"},product.id);
      const native=new ExternalNativeSessionStore(store);native.connect("owner",id,node.nodeId);
      native.listForNode("owner",node.nodeId,"fixture-worker-one",()=>{});
      snapshotHeaders={...snapshotHeaders,"x-missiongo-external-generation":"1","x-missiongo-external-worker":"fixture-worker-one"};
    } else {
      id=create("dispatch");
      if(kind==="project") {
        // A project conversation is isolated by its explicit product association.
        db.prepare("DELETE FROM dispatch_items WHERE dispatch_id='dispatch'").run();
        db.prepare(`INSERT INTO free_session_starts(account_id,request_key,dispatch_id,product_id,initial_text,config_json) VALUES ('owner','request','dispatch',?,'Fixture','{}')`).run(product.id);
      }
    }
    const href="/tmp/fixture-output/image.png";
    const payload={status:"idle",messages:[{sourceId:"image-source",role:"agent",text:`[Image](${href})`},{sourceId:"user",role:"user",text:"[User image](/tmp/fixture-output/user.png)"}]};
    const snapshot=()=>app.inject({method:"POST",url:`/api/v1/node/agent-sessions/${id}/snapshot`,headers:snapshotHeaders,payload});
    const first=await snapshot();expect(first.statusCode,first.body).toBe(204);
    expect((await snapshot()).statusCode).toBe(204);
    const nodeHeaders={authorization:`Bearer ${node.token}`};
    const jobs=(await app.inject({method:"GET",url:"/api/v1/node/agent-artifacts",headers:nodeHeaders})).json().jobs;
    expect(jobs).toHaveLength(1);expect(jobs[0]).toMatchObject({sessionId:id,sourceId:"image-source",href});
    const bundle={entry:"image.png",files:[{name:"image.png",contentType:"image/png",base64:Buffer.from("fixture").toString("base64")}]};
    expect((await app.inject({method:"POST",url:`/api/v1/node/agent-artifacts/${jobs[0].id}`,headers:nodeHeaders,payload:{bundle}})).statusCode).toBe(204);
    const login=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:"owner@example.test",password:"fixture-password"}});
    expect(login.statusCode,login.body).toBe(200);
    const headers={cookie:login.headers["set-cookie"]!.split(";",1)[0]!};
    const readState=()=>db.prepare("SELECT session_key,read_source_at FROM session_unread_state ORDER BY session_key").all();
    const before=readState();
    const metadata=await app.inject({method:"GET",url:`/api/v1/agent-artifact-preloads?sessions=${id}`,headers});
    expect(metadata.statusCode).toBe(200);expect(metadata.json().images).toEqual([{id:jobs[0].id,sessionId:id,sourceId:"image-source",href,sizeBytes:Buffer.byteLength(JSON.stringify(bundle))}]);
    expect(metadata.body).not.toContain("base64");expect(readState()).toEqual(before);
    expect((await app.inject({method:"GET",url:`/api/v1/agent-artifact-preloads?sessions=${id}`})).statusCode).toBe(401);
    expect((await app.inject({method:"GET",url:`/api/v1/agent-artifact-preloads?sessions=${Array(9).fill(id).join(",")}`,headers})).statusCode).toBe(400);
    if(kind==="dispatch") {
      const mirror=create("mirror");
      sessions.recordSnapshot({nodeId:node.nodeId,sessionId:mirror,status:"idle",messages:payload.messages as Parameters<AgentSessionStore["recordSnapshot"]>[0]["messages"]});
      const message=sessions.getForAccount("owner",mirror).messages.find(m=>m.sourceId==="image-source")!;
      const reuse=await app.inject({method:"POST",url:`/api/v1/agent-sessions/${mirror}/artifacts`,headers,payload:{messageId:message.id,href}});
      expect(reuse.json()).toMatchObject({id:jobs[0].id,status:"ready"});
      expect((await app.inject({method:"GET",url:`/api/v1/agent-sessions/${mirror}/artifacts/${jobs[0].id}/bundle`,headers})).json()).toEqual(bundle);
      expect((db.prepare("SELECT COUNT(*) AS n FROM agent_artifacts").get() as {n:number}).n).toBe(1);
      const unrelated=create("unrelated");db.prepare("UPDATE agent_sessions SET agent_session_ref='other-thread' WHERE id=?").run(unrelated);
      expect((await app.inject({method:"GET",url:`/api/v1/agent-sessions/${unrelated}/artifacts/${jobs[0].id}/bundle`,headers})).statusCode).toBe(404);
    }
    // Builder handover revokes this original execution channel even if product rights remain.
    const pendingSnapshot=await app.inject({method:"POST",url:`/api/v1/node/agent-sessions/${id}/snapshot`,headers:snapshotHeaders,
      payload:{status:"idle",messages:[{sourceId:"pending",role:"agent",text:"[Pending](/tmp/fixture-output/pending.png)"}]}});
    expect(pendingSnapshot.statusCode,pendingSnapshot.body).toBe(204);
    const pendingJob=(await app.inject({method:"GET",url:"/api/v1/node/agent-artifacts",headers:nodeHeaders})).json().jobs[0];
    expect(pendingJob).toBeDefined();
    db.prepare(`INSERT INTO builder_handovers(id,item_id,initiated_by,note,status,created_at,updated_at)
      VALUES ('handover',?,'owner','Fixture transfer','completed',?,?)`).run(item.id,now,now);
    if(kind==="external")db.prepare("INSERT INTO builder_revoked_external_sessions(session_id,handover_id) VALUES (?,'handover')").run(id);
    else db.prepare("INSERT INTO builder_revoked_dispatches(dispatch_id,handover_id) VALUES ('dispatch','handover')").run();
    // Submission is checked independently, before GET has a chance to reject the pending job.
    expect((await app.inject({method:"POST",url:`/api/v1/node/agent-artifacts/${pendingJob.id}`,headers:nodeHeaders,payload:{bundle}})).statusCode).toBe(409);
    const revokedSnapshot=await app.inject({method:"POST",url:`/api/v1/node/agent-sessions/${id}/snapshot`,headers:snapshotHeaders,
      payload:{status:"idle",messages:[{sourceId:"revoked",role:"agent",text:"[Denied](/tmp/fixture-output/revoked.png)"}]}});
    expect([204,409]).toContain(revokedSnapshot.statusCode);
    expect((db.prepare("SELECT COUNT(*) AS n FROM agent_artifacts").get() as {n:number}).n).toBe(2);
    expect((await app.inject({method:"GET",url:"/api/v1/node/agent-artifacts",headers:nodeHeaders})).json().jobs).toEqual([]);
    expect((await app.inject({method:"GET",url:`/api/v1/agent-sessions/${id}/artifacts/${jobs[0].id}/bundle`,headers})).statusCode).toBe(200);
    // Reset only the synthetic fixture boundary to exercise product-right revocation separately below.
    db.prepare(kind==="external" ? "DELETE FROM builder_revoked_external_sessions" : "DELETE FROM builder_revoked_dispatches").run();
    app.missionGoAccounts.createAccount({email:"other-admin@example.test",password:"fixture-password",role:"admin"});
    app.missionGoAccounts.updateAccount("owner",{role:"member"});
    app.missionGoAccounts.replacePermissions("owner",[{productId:product.id,canView:true,canOperate:false,canUseAi:false}]);
    // Saved content stays readable with view permission; collection may not acquire more files.
    expect((await app.inject({method:"GET",url:`/api/v1/agent-sessions/${id}/artifacts/${jobs[0].id}/bundle`,headers})).statusCode).toBe(200);
    const newSnapshot=await app.inject({method:"POST",url:`/api/v1/node/agent-sessions/${id}/snapshot`,headers:snapshotHeaders,payload:{status:"idle",messages:[{sourceId:"new-image",role:"agent",text:"[New](/tmp/fixture-output/new.png)"}]}});
    expect([204,404]).toContain(newSnapshot.statusCode);
    expect((db.prepare("SELECT COUNT(*) AS n FROM agent_artifacts").get() as {n:number}).n).toBe(2);
    app.missionGoAccounts.replacePermissions("owner",[]);
    expect((await app.inject({method:"GET",url:`/api/v1/agent-artifact-preloads?sessions=${id}`,headers})).statusCode).toBe(404);
    expect((await app.inject({method:"GET",url:`/api/v1/agent-sessions/${id}/artifacts/${jobs[0].id}/bundle`,headers})).statusCode).toBe(404);
  } finally {await app.close();await rm(root,{recursive:true,force:true});}
});
