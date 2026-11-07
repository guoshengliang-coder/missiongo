import { afterEach, expect, it } from "vitest";
import type { RequestStateCodec, ServerContext } from "@modelcontextprotocol/server";
import { NativeHumanConfirmations } from "./native-human-confirmation.js";
import { MissionGoDatabase } from "./storage/database.js";

const databases:MissionGoDatabase[]=[];
afterEach(()=>{for(const db of databases.splice(0)) db.close();});
function fixture(elicit:()=>Promise<unknown>) {
  const db=new MissionGoDatabase(":memory:");databases.push(db);
  db.connection.exec("CREATE TABLE native_effect (id INTEGER PRIMARY KEY)");
  const confirmations=new NativeHumanConfirmations(db);
  let allowed=true,version=1;
  const ctx={mcpReq:{requestState:()=>undefined,elicitInput:elicit}} as unknown as ServerContext;
  const options={ctx,codec:{} as RequestStateCodec<{revision:string}>,modern:false,accountId:"owner",clientId:"client",tool:"fixture",targetId:"object",requestKey:"stable",parameters:{id:"object"},description:"Only this exact fixture action",
    inspect:()=>{if(!allowed)throw new Error("Permission revoked");return {content:{version}};},
    apply:()=>{db.connection.exec("INSERT INTO native_effect DEFAULT VALUES");return {created:true};}};
  return {db,confirmations,options,revoke:()=>{allowed=false;},change:()=>{version++;},count:()=>db.connection.prepare("SELECT COUNT(*) AS n FROM native_effect").get()};
}
it.each(["accept","decline","cancel"])("uses only the legacy native client's %s response",async action=>{
  const f=fixture(async()=>({action,content:action==="accept"?{}:null}));
  const result=await f.confirmations.request(f.options);
  expect(result).toMatchObject({structuredContent:{approved:action==="accept",source:"native"}});
  await f.confirmations.request(f.options);
  expect(f.count()).toEqual({n:action==="accept"?1:0});
  expect(f.db.connection.prepare("SELECT COUNT(*) AS n FROM native_human_confirmations").get()).toEqual({n:1});
});
it.each(["permission","content"])("rechecks %s after an awaited legacy native response",async changed=>{
  let answer!:(result:unknown)=>void;
  const pending=new Promise(resolve=>{answer=resolve;});
  const f=fixture(()=>pending);
  const request=f.confirmations.request(f.options);
  if(changed==="permission") f.revoke(); else f.change();
  answer({action:"accept",content:{}});
  await expect(request).rejects.toThrow();
  expect(f.count()).toEqual({n:0});
  expect(f.db.connection.prepare("SELECT COUNT(*) AS n FROM native_human_confirmations").get()).toEqual({n:0});
});
it.each([{approved:true},true,1,"accept"])("does not accept invented legacy answer content %j",async content=>{
  const f=fixture(async()=>({action:"accept",content}));
  expect(await f.confirmations.request(f.options)).toMatchObject({structuredContent:{approved:false,code:"native_confirmation_unavailable"}});
  expect(f.count()).toEqual({n:0});
});
