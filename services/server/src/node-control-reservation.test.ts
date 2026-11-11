import {afterEach,expect,it} from "vitest";
import {buildApp} from "./app.js";
import {DispatchStore} from "./dispatch-store.js";
import {TEST_CONSOLE_ACCOUNT} from "./testing-fixtures.js";
const apps:ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{for(const app of apps.splice(0))await app.close();});
it("distinguishes a fresh reservation from already settled command acknowledgements",async()=>{
 const app=buildApp({databasePath:":memory:",adminAccount:TEST_CONSOLE_ACCOUNT});apps.push(app);
 const db=app.missionGoStore.database.connection,at=new Date().toISOString();
 const node=new DispatchStore(app.missionGoStore.database).registerNode({accountId:TEST_CONSOLE_ACCOUNT.id,installationId:"reservation-wire-fixture",name:"Synthetic"});
 db.prepare("INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at) VALUES ('dispatch',?,?,'codex','default','launched','synthetic',?)").run(TEST_CONSOLE_ACCOUNT.id,node.nodeId,at);
 db.prepare("INSERT INTO agent_sessions(id,dispatch_id,node_id,agent_kind,agent_session_ref,status,created_at,updated_at) VALUES ('session','dispatch',?,'codex','ref','idle',?,?)").run(node.nodeId,at,at);
 db.prepare("UPDATE agent_sessions SET agent_kind='opencode', turn_state_json=? WHERE id='session'").run(JSON.stringify({waitingForPermission:true}));
 const headers={authorization:`Bearer ${node.token}`};
 for(const status of ["queued","delivered","cancelled","delivery_unknown"]){
  db.prepare("DELETE FROM agent_session_commands").run();
  db.prepare("INSERT INTO agent_session_commands(id,session_id,account_id,text,status,created_at) VALUES ('command','session',?,'input',?,?)").run(TEST_CONSOLE_ACCOUNT.id,status,at);
  const response=await app.inject({method:"POST",url:"/api/v1/node/agent-sessions/session/snapshot",headers,payload:{status:"idle",messages:[],commandId:"command",commandStatus:"delivering"}});
  expect(response.statusCode).toBe(204);
  expect(JSON.parse((db.prepare("SELECT turn_state_json FROM agent_sessions WHERE id='session'").get() as {turn_state_json:string}).turn_state_json).waitingForPermission).toBe(true);
  expect(response.headers["x-missiongo-command-status"]).toBe(status==="queued"?"delivering":status);
 }
});
