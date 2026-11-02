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
 if (options.method === "POST" && /\/handovers\/[^/]+\/confirm$/.test(path) && payload && typeof payload === "object" && !Buffer.isBuffer(payload)) {
  const body={...payload} as Record<string,unknown>;
  const handoverId=path.split("/").at(-2)!;
  const row=app.missionGoStore.database.connection.prepare("SELECT revision,item_id FROM status_handovers WHERE id=?").get(handoverId) as {revision:number;item_id:string}|undefined;
  if (row) {body.expectedHandoverRevision ??=row.revision;body.expectedItemRevision ??=(app.missionGoStore.database.connection.prepare("SELECT revision FROM work_items WHERE id=?").get(row.item_id) as {revision:number}).revision;body.idempotencyKey ??=randomUUID();}
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
