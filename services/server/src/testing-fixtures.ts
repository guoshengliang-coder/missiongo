import { normalizeAgentMode } from "@missiongo/domain";
import { ImplementationPlans } from "./implementation-plans.js";
import { hashPassword } from "./admin-auth.js";
import { randomUUID } from "node:crypto";
import type { MissionGoStore } from "./store.js";
/** Domain tests use named identities without signing in; seed real active accounts for policy evaluation. */
export function seedStoreActors(store:MissionGoStore,ids:readonly string[]) {
 const now=new Date().toISOString();
 for(const id of ids) store.database.connection.prepare(`INSERT OR IGNORE INTO accounts
  (id,email,password_scrypt,role,credentials_changed_at,created_at,updated_at,ai_scope) VALUES (?,?,'test-only','admin',?,?,?,'all')`)
  .run(id,`${id}@example.test`,now,now,now);
}

/** Existing console tests read the current snapshot before issuing a version-bound command, as the UI does. */
export function versionedTestRequest(app:import("fastify").FastifyInstance, options:import("light-my-request").InjectOptions) {
 const path=String(options.url ?? ""), payload=options.payload;
 if (options.method === "POST" && /\/items\/(?:[^/]+\/)?transitions$/.test(path) && payload && typeof payload === "object" && !Buffer.isBuffer(payload)) {
  const body={...payload} as Record<string,unknown>;
  if (path.endsWith("/items/transitions")) {
   if (Array.isArray(body.itemKeys)) body.expectedRevisions ??= Object.fromEntries(body.itemKeys.flatMap(key=>{
    try {return [[key,app.missionGoStore.getWorkItem(String(key)).revision]];} catch{return [];}
   }));
  } else {
   const key=path.split("/").at(-2)!;
   try {const item=app.missionGoStore.getWorkItem(key);body.expectedRevision ??= item.revision;body.expectedStatus ??= item.status;} catch{/* Unknown-item tests must remain unknown. */}
  }
  body.idempotencyKey ??= randomUUID();
  if (["on_hold","cancelled"].includes(String(body.to))) body.executionDisposition ??="keep_running";
  options={...options,payload:body};
 }
 return app.inject(options);
}

export const TEST_CONSOLE_ACCOUNT = {
 id:"fixture-console-admin",username:"fixture@example.test",passwordScrypt:hashPassword("fixture-password"),
 sessionSecret:"fixture-console-signing-secret-for-tests",cookieSecure:false,
};
export async function testConsoleHeaders(app:import("fastify").FastifyInstance) {
 const response=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:TEST_CONSOLE_ACCOUNT.username,password:"fixture-password"}});
 if (response.statusCode !== 200) throw new Error(`Fixture sign-in failed: ${response.statusCode} ${response.body}`);
 const value=response.headers["set-cookie"];
 return {cookie:(Array.isArray(value)?value[0]:value)!.split(";")[0]!};
}

/** Seed a scoped human plan decision for tests of follow-on MCP workflows.
 * Gate/approval tests deliberately do not use this fixture. Only synthetic test tokens belong here. */
export function approvedClaimFixture(store: MissionGoStore, token: string, args: Record<string,unknown>) {
 const access=JSON.parse(Buffer.from(token.replace(/^mgai_/,"").split(".")[0]!,"base64url").toString()) as {id:string;clientId?:string};
 const session=args.session as {agentKind:string;refKind:string;sessionRef:string}|undefined;
 const project=session?.refKind==="native" ? store.database.connection.prepare(`SELECT d.id FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id
   JOIN free_session_starts f ON f.dispatch_id=d.id WHERE d.account_id=? AND s.agent_kind=? AND s.agent_session_ref=? LIMIT 1`).get(access.id,session.agentKind,session.sessionRef) as {id:string}|undefined : undefined;
 const dispatchId=typeof args.dispatchId==="string" ? args.dispatchId : project?.id;
 const identity=dispatchId ? `dispatch:${dispatchId}` : session ? `native:${access.clientId ?? ""}:${session.agentKind}:${session.refKind}:${session.sessionRef}` : "";
 const plans=new ImplementationPlans(store.database);
 let keys=dispatchId ? plans.dispatchKeys(dispatchId) : [];
 if(!keys.includes(String(args.itemKey))) keys.push(String(args.itemKey));
 try {
  plans.record({accountId:access.id,identity,revision:`fixture:${plans.scope(keys)}`,planHash:"approved test plan",keys,source:"web"});
  if(dispatchId) {
   const session=store.database.connection.prepare("SELECT agent_kind,implementation_mode FROM agent_sessions WHERE dispatch_id=?").get(dispatchId) as {agent_kind:string;implementation_mode:string}|undefined;
   if(session) {
    const target=normalizeAgentMode(session.agent_kind,session.implementation_mode);
    const applied=target==="plan" ? session.agent_kind==="opencode" ? "build" : "default" : target;
    store.database.connection.prepare("UPDATE agent_sessions SET mode=?,implementation_mode=?,applied_settings_revision=settings_revision WHERE dispatch_id=?").run(applied,applied,dispatchId);
   }
  }
 }
 catch { /* Invalid-scope tests retain their original authorization failure. */ }
}
