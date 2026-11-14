import { ConsolePerformance } from "./console-performance.js";
import { afterEach, expect, it, vi } from "vitest";
import { hashPassword } from "./admin-auth.js";
import { buildApp } from "./app.js";
const apps:ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(apps.splice(0).map(app=>app.close()));});
async function fixture(){
 const app=buildApp({adminAccount:{id:"owner",username:"owner@example.invalid",passwordScrypt:hashPassword("synthetic-password"),sessionSecret:"synthetic-signing",cookieSecure:false},performance:{enabled:true,path:":memory:"},dingtalkWorker:false,release:"fixture-build"});apps.push(app);
 const member=app.missionGoAccounts.createAccount({email:"member@example.invalid",password:"synthetic-password",role:"member"});
 const product=app.missionGoStore.createProduct({name:"Visible",keyPrefix:"VIS"}),hidden=app.missionGoStore.createProduct({name:"Hidden",keyPrefix:"HID"});
 app.missionGoAccounts.grantCreatorPermissions(member.id,product.id);
 const login=async(username:string)=>{const r=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username,password:"synthetic-password"}});return {cookie:r.headers["set-cookie"]!.split(";",1)[0]!};};
 const headers=await login(member.email),owner=await login("owner@example.invalid");
 for(let i=0;i<50;i++){const r=await app.inject({url:"/api/v1/console/performance",headers});if(r.json().status.ready)break;await new Promise(r=>setTimeout(r,20));}
 const post=(productId:string,events:unknown)=>app.inject({method:"POST",url:"/api/v1/console/performance",headers,payload:{productId,events}});
 return {app,member,headers,owner,product,hidden,post};
}
it("only the authenticated owner's authorized product metrics are visible, including after revocation",async()=>{
 const f=await fixture(),event={id:"synthetic-stable",stage:"submit",result:"success",durationMs:22.6};
 expect((await f.post(f.product.id,[event])).statusCode).toBe(202);expect((await f.post(f.product.id,[event])).statusCode).toBe(202);
 const r=await f.app.inject({url:`/api/v1/console/performance?to=${Date.now()+1}`,headers:f.headers});expect(r.statusCode).toBe(200);expect(r.json().rows).toHaveLength(1);expect(r.json().rows[0].n).toBe(1);
 const other=await f.app.inject({url:"/api/v1/console/performance",headers:f.owner});expect(other.json().rows).toEqual([]);expect(other.body).not.toContain(f.product.id);
 expect((await f.post(f.hidden.id,[event])).statusCode).toBe(404);
 f.app.missionGoStore.database.connection.prepare("DELETE FROM product_administrators WHERE account_id=?").run(f.member.id);
 f.app.missionGoStore.database.connection.prepare("DELETE FROM account_products WHERE account_id=?").run(f.member.id);
 expect((await f.app.inject({url:"/api/v1/console/performance",headers:f.headers})).json().rows).toEqual([]);
});
it("rejects free text, invalid duration, excess payload and missing authentication",async()=>{
 const f=await fixture();
 for(const event of [{id:"x",stage:"submit",result:"success",message:"sensitive"},{id:"x",stage:"submit",result:"success",durationMs:-1},{id:"x",stage:"arbitrary",result:"success"}])expect((await f.post(f.product.id,[event])).statusCode).toBe(400);
 expect((await f.post(f.product.id,Array.from({length:33},()=>({id:"x",stage:"submit",result:"success"})))).statusCode).toBe(400);
 expect((await f.app.inject({url:"/api/v1/console/performance"})).statusCode).toBe(401);
 expect((await f.app.inject({url:"/api/v1/console/performance?from=0&to=999999999999999",headers:f.headers})).statusCode).toBe(400);
});

it("rechecks account authorization after the asynchronous report even when no rows exist",async()=>{
 const f=await fixture();
 vi.spyOn(ConsolePerformance.prototype,"report").mockImplementation(async()=>{
  f.app.missionGoAccounts.updateAccount(f.member.id,{disabled:true});
  return {status:{enabled:true,ready:true,degraded:false},rows:[],coverage:[],complete:false};
 });
 const result=await f.app.inject({url:"/api/v1/console/performance",headers:f.headers});expect(result.statusCode).toBe(401);
});
