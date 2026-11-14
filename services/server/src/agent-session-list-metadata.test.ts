import {afterEach, expect, it, vi} from "vitest";
import {MissionGoStore} from "./store.js";
import {AgentSessionStore} from "./agent-session-store.js";
import {AgentSessionAttachments} from "./agent-session-attachments.js";
import {ImplementationPlans} from "./implementation-plans.js";
import {commandSourceMessage, commandSourceMessages} from "./command-source-message.js";

const stores: MissionGoStore[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();stores.splice(0).forEach(store=>store.close());});
function fixture(count=4){
  vi.useFakeTimers();vi.setSystemTime("2026-11-14T10:00:00Z");
  const store=new MissionGoStore(":memory:");stores.push(store);const db=store.database.connection;
  const product=store.createProduct({name:"List fixture",keyPrefix:"LF"});
  const item=store.createWorkItem({productId:product.id,title:"List",description:"",type:"task",status:"ready",priority:"normal",environment:{platform:"server"}});
  const now=new Date().toISOString(),agents=JSON.stringify([{kind:"codex",models:[{id:"model-a",efforts:["high"]}]},{kind:"claude_code"}]);
  for(const node of ["one","two"])db.prepare("INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at) VALUES (?,'owner',?,?,?, ?,?,?,?)").run(node,node,node,node,agents,now,now,now);
  const attachments=new AgentSessionAttachments(store.database,"synthetic-list-no-files");
  const sessions=new AgentSessionStore(store.database,attachments);
  const ids:string[]=[];
  for(let n=0;n<count;n++){
    const node=n%2?"two":"one";
    db.prepare("INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at) VALUES (?,'owner',?,'codex','default','launched','synthetic',?)").run(`d${n}`,node,now);
    db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES (?,?,0)").run(`d${n}`,item.id);
    const id=sessions.createForDispatch({dispatchId:`d${n}`,nodeId:node,sessionRef:`thread${n}`});ids.push(id);
    for(const [suffix,kind] of [["m","message"],["s","interrupt"]])db.prepare("INSERT INTO agent_session_commands(id,session_id,account_id,kind,text,status,created_at) VALUES (?,?,'owner',?,?, 'delivered',?)").run(`${suffix}${n}`,id,kind,"synthetic",kind==="interrupt"?"2026-11-14T09:59:59Z":now);
    db.prepare("INSERT INTO agent_session_messages(id,session_id,source_id,role,text,position,observed_at,occurred_at) VALUES (?,?,?,'user','synthetic',0,?,?)").run(`msg${n}`,id,`answer-m${n}`,now,now);
  }
  return {store,db,now,agents,sessions,attachments,ids};
}

it("keeps exact-session provenance, command priority and execution exclusion in the batch",()=>{
  const f=fixture();const insert=f.db.prepare("INSERT INTO agent_session_messages(id,session_id,source_id,role,phase,text,position,observed_at,occurred_at) VALUES (?,?,?,?,?,'synthetic',?,?,?)");
  insert.run("exact",f.ids[0],"m0","user",null,1,f.now,f.now);
  insert.run("other",f.ids[1],"m0","user",null,1,f.now,f.now);
  insert.run("execution",f.ids[2],"m2","user","execution",1,f.now,f.now);
  insert.run("agent",f.ids[3],"m3","agent",null,1,f.now,f.now);
  const commands=["m0","m1","m2","m3","s0","missing","m0"];
  const batch=commandSourceMessages(f.db,commands);
  for(const id of commands)expect(batch.get(id)).toBe(commandSourceMessage(f.db,id).sourceMessageId);
  expect(batch.get("m0")).toBe("m0");expect(batch.get("m2")).toBe("answer-m2");
  expect(commandSourceMessages(f.db,[]).size).toBe(0);
});

it("preserves attachment order and public fields and approval versions",()=>{
  const f=fixture();
  const insert=f.db.prepare("INSERT INTO agent_session_attachments(id,session_id,account_id,command_id,filename,storage_filename,kind,content_type,size_bytes,sha256,created_at) VALUES (?,?,'owner',?,'fixture.png',?,'image','image/png',1,'synthetic',?)");
  for(const [id,command] of [["b","m0"],["a","m0"],["c","m1"]])insert.run(id,f.ids[0],command,id,f.now);
  const ids=["m0","m1","s0","missing","m0"],batch=f.attachments.listForCommands(ids);
  for(const id of ids)expect(batch.get(id)??[]).toEqual(f.attachments.listForCommand(id));
  expect(batch.get("m0")?.map(a=>a.id)).toEqual(["b","a"]);
  f.db.prepare("INSERT INTO implementation_plan_approvals(id,account_id,identity_key,revision,plan_hash,scope_json,plan_text,validation_text,source,command_id,approved_at) VALUES ('approval','owner','synthetic','rev','rev','[]','','','web','m0',?)").run(f.now);
  const plans=new ImplementationPlans(f.store.database);
  const revisions=plans.commandRevisions(ids);
  for(const id of ids)expect(revisions.get(id)).toBe(plans.commandRevision(id));
  expect(plans.commandRevisions([]).size).toBe(0);
});

it("maps list commands once in fixed batches and leaves detail commands equivalent",()=>{
  const f=fixture(40);
  const singleAttachments=vi.spyOn(f.attachments,"listForCommand");
  const batchAttachments=vi.spyOn(f.attachments,"listForCommands");
  const singleRevision=vi.spyOn(ImplementationPlans.prototype,"commandRevision");
  const batchRevision=vi.spyOn(ImplementationPlans.prototype,"commandRevisions");
  const rows=f.sessions.listForAccount("owner",100);
  expect(rows).toHaveLength(40);
  expect(singleAttachments).not.toHaveBeenCalled();expect(singleRevision).not.toHaveBeenCalled();
  expect(batchAttachments).toHaveBeenCalledTimes(1);expect(batchRevision).toHaveBeenCalledTimes(1);
  expect(new Set(batchAttachments.mock.calls[0]![0]).size).toBe(80);
  for(const row of rows){const detail=f.sessions.getForAccount("owner",row.id);expect(row.command).toEqual(detail.command);expect(row.stopCommand).toEqual(detail.stopCommand);}
  expect(f.sessions.listForAccount("someone-else")).toEqual([]);
});

it("parses shared node capabilities once per kind per request and sees updates next time",()=>{
  const f=fixture(20);const parse=JSON.parse;let reads=0;
  vi.spyOn(JSON,"parse").mockImplementation((...args:Parameters<typeof JSON.parse>)=>{if(args[0]===f.agents)reads++;return parse(...args);});
  let rows=f.sessions.listForAccount("owner",100);expect(rows.every(row=>row.settings.adjustable)).toBe(true);expect(reads).toBe(1);
  f.db.prepare("UPDATE nodes SET agents_json='[]' WHERE id='one'").run();
  reads=0;rows=f.sessions.listForAccount("owner",100);
  for(const row of rows)expect(row.settings.adjustable).toBe(row.nodeId==="two");
  expect(reads).toBe(1);
  f.db.prepare("UPDATE dispatches SET agent_kind='claude_code' WHERE id='d1'").run();
  expect(f.sessions.listForAccount("owner",100).find(row=>row.dispatchId==="d1")?.settings.adjustable).toBe(false);
  f.db.prepare("UPDATE agent_sessions SET archived_at=?").run(f.now);
  expect(f.sessions.listForAccount("owner",100).every(row=>!row.settings.adjustable)).toBe(true);
  // Closed settings must not parse capabilities that are never used.
  f.db.prepare("UPDATE nodes SET agents_json='invalid-json'").run();
  expect(f.sessions.listForAccount("owner",100).every(row=>!row.settings.adjustable)).toBe(true);
  expect(f.sessions.listForAccount("owner",100,[])).toEqual([]);
});
