import { randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommonCommandStore } from "./common-commands.js";
import { MissionGoDatabase } from "./storage/database.js";
import { buildApp } from "./app.js";
const create = (content="first") => ({requestId:randomUUID(),revision:0,action:{kind:"create",content,name:"",favorite:false}});
describe("account common commands",()=>{
 it("isolates owners, replays unchanged requests without duplicating and rejects stale or changed requests",()=>{
  const db=new MissionGoDatabase(":memory:");try{const store=new CommonCommandStore(db),input=create();const first=store.change("alice",input);
   expect(first.commands).toHaveLength(1);expect(store.list("bob")).toEqual({revision:0,commands:[]});
   expect(store.change("alice",input)).toEqual(first);
   expect(()=>store.change("alice",{...input,action:{...input.action,content:"changed"}})).toThrow("request changed");
   expect(()=>store.change("alice",create("stale"))).toThrow("another device");
   expect(()=>store.change("bob",{requestId:randomUUID(),revision:0,action:{kind:"delete",id:first.commands[0]!.id}})).toThrow("not found");
   expect(store.list("alice")).toEqual(first);
  }finally{db.close()}
 });
 it("keeps ordering, explicit favorites and Unicode limits without silently dropping data",()=>{
  const db=new MissionGoDatabase(":memory:");try{const store=new CommonCommandStore(db);let s=store.change("a",create("first"));s=store.change("a",{...create("second"),revision:s.revision});const second=s.commands[1]!;
   s=store.change("a",{requestId:randomUUID(),revision:s.revision,action:{kind:"favorite",id:second.id,favorite:true}});
   s=store.change("a",{requestId:randomUUID(),revision:s.revision,action:{kind:"move",id:second.id,direction:"up"}});expect(s.commands[0]).toMatchObject({content:"second",favorite:true});
   expect(()=>store.change("a",{...create("x".repeat(3001)),revision:s.revision})).toThrow("Invalid command");
   s=store.change("a",{...create("😀".repeat(3000)),revision:s.revision});expect(s.commands).toHaveLength(3);
   const key={requestId:randomUUID(),revision:s.revision,action:{kind:"delete",id:second.id}};s=store.change("a",key);expect(store.change("a",key)).toEqual(s);expect(s.commands).toHaveLength(2);
  }finally{db.close()}
 });
 it("persists account content and migrates idempotently",()=>{const dir=mkdtempSync(join(tmpdir(),"mg-commands-"));try{const path=join(dir,"test.sqlite");let db=new MissionGoDatabase(path);const saved=new CommonCommandStore(db).change("a",create());db.close();db=new MissionGoDatabase(path);expect(new CommonCommandStore(db).list("a")).toEqual(saved);db.close()}finally{rmSync(dir,{recursive:true,force:true})}});
 it("requires authenticated HTTP access and ignores client-supplied account ownership",async()=>{
  const salt=Buffer.from("command-test-salt"),password="a sufficiently long test password";
  const app=buildApp({adminAccount:{id:"owner",username:"owner@example.test",passwordScrypt:`scrypt:${salt.toString("base64url")}:${scryptSync(password,salt,64).toString("base64url")}`,sessionSecret:"a-test-session-secret-with-enough-length",cookieSecure:false}});
  try{expect((await app.inject({method:"GET",url:"/api/v1/common-commands"})).statusCode).toBe(401);
   const login=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:"owner@example.test",password}});const cookie=String(login.headers["set-cookie"]).split(";")[0]!;
   const saved=await app.inject({method:"POST",url:"/api/v1/common-commands",headers:{cookie},payload:{...create(),accountId:"someone-else"}});expect(saved.statusCode).toBe(200);
   expect((await app.inject({method:"GET",url:"/api/v1/common-commands",headers:{cookie}})).json().commands).toHaveLength(1);
  }finally{await app.close()}
 });
});
