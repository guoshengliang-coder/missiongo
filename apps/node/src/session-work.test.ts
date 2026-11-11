import {expect, it, vi, afterEach} from "vitest";
import {chmodSync, mkdtempSync, rmSync} from "node:fs";
import {createServer} from "node:http";
import {SessionWorkQueue, SessionUploadGate, SnapshotReports, SnapshotHealth, ControlReports, observationSession} from "./session-work.js";
import {hostCall,socketPath} from "./host.js";
import {API,APIError} from "./api.js";
import type {Session,Snapshot} from "./types.js";
afterEach(()=>vi.restoreAllMocks());
it.each([1,10,50])("bounds %s sessions, coalesces repeated wakes and keeps one owner per identity", async count => {
  const gate=Promise.withResolvers<void>(); const active=new Set<string>(); let peak=0; let calls=0;
  const errors:unknown[]=[]; const queue=new SessionWorkQueue(error=>errors.push(error));
  const work=(key:string)=>async()=>{expect(active.has(key)).toBe(false);active.add(key);peak=Math.max(peak,active.size);calls++;await gate.promise;active.delete(key);};
  for(let i=0;i<count;i++) {queue.submit(String(i),work(String(i)));queue.submit(String(i),work(String(i)));}
  expect(peak).toBe(Math.min(count,4)); gate.resolve();
  await vi.waitFor(()=>expect(active.size).toBe(0)); await queue.finish();
  expect(calls).toBeGreaterThanOrEqual(count);expect(calls).toBeLessThanOrEqual(count+4);expect(errors).toEqual([]);
});
it("a blocked mirror does not block the same session's separate control lane",async()=>{
  const release=Promise.withResolvers<void>();let controlled=false;const errors:unknown[]=[];
  const mirror=new SessionWorkQueue(e=>errors.push(e)),control=new SessionWorkQueue(e=>errors.push(e));
  mirror.submit("same",()=>release.promise);control.submit("same",async()=>{controlled=true;});
  await vi.waitFor(()=>expect(controlled).toBe(true));release.resolve();await Promise.all([mirror.finish(),control.finish()]);expect(errors).toEqual([]);
});
it("serializes uploads while allowing native reads to proceed independently", async()=>{
  const gate=new SessionUploadGate(), release=Promise.withResolvers<void>();const order:string[]=[];
  const first=gate.run("same",async()=>{order.push("old-start");await release.promise;order.push("old-end");});
  const next=gate.run("same",async()=>{order.push("stop-result");});
  await Promise.resolve();expect(order).not.toContain("stop-result");release.resolve();await Promise.all([first,next]);expect(order).toEqual(["old-start","old-end","stop-result"]);
});
it("only suppresses acknowledged identical snapshots and refreshes health without inventing progress",()=>{
  const reports=new SnapshotReports(), health=new SnapshotHealth();const snapshot:Snapshot={status:"active",messages:[],turnActive:true};
  const first=health.observe("s",snapshot,100_000),hash=reports.fingerprint(first);
  expect(reports.needed("s",hash,100_000)).toBe(true);reports.confirm("s",hash,100_000);
  expect(reports.needed("s",reports.fingerprint(health.observe("s",snapshot,110_000)),110_000)).toBe(false);
  const refresh=health.observe("s",snapshot,130_001);expect(refresh.observedAt).not.toBe(first.observedAt);expect(refresh.lastProgressAt).toBe(first.lastProgressAt);
  reports.failed("s");expect(reports.needed("s",hash,110_000)).toBe(true);
  expect(health.observe("s",{...snapshot,messages:[{sourceId:"new",role:"agent",text:"progress"}]},140_000).lastProgressAt).not.toBe(first.lastProgressAt);
});
it("strips every control side effect from mirror work",()=>{
  const session:Session={id:"s",sessionRef:"ref",agentKind:"codex",lifecycle:"close",archiveInSource:true,restoreInSource:true,
    command:{id:"c",text:"input",status:"delivering"},desiredSettings:{revision:1},approvalDecision:{id:"a",choice:"accept"},approvalRetry:{id:"r",reviewId:"a",status:"queued"}};
  expect(observationSession(session)).toEqual({id:"s",sessionRef:"ref",agentKind:"codex",lifecycle:"keep"});
});
it("negotiates old hosts read-only and never falls back after a control request failure",async()=>{
  for(const modern of [false,true]) {
    const root=mkdtempSync("/tmp/control-host-");const calls:string[]=[];const socket=socketPath(root,"host");
    const server=createServer((req,res)=>{calls.push(req.url!);req.resume();req.on("end",()=>{
      if(req.url==="/capabilities")res.writeHead(modern?200:404).end(JSON.stringify({protocol:1}));
      else if(req.url==="/control")res.writeHead(409).end();else res.writeHead(200).end(JSON.stringify({status:"idle",messages:[]}));
    });});
    try {
      await new Promise<void>(resolve=>server.listen(socket,resolve));chmodSync(socket,0o600);
      const call=hostCall(root,"host",{id:"s",sessionRef:"ref",agentKind:"codex"},"control");
      if(modern) {await expect(call).rejects.toThrow();expect(calls).toEqual(["/capabilities","/control"]);}
      else {expect(await call).toMatchObject({status:"idle"});expect(calls).toEqual(["/capabilities","/sync"]);}
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
  }
});
it("falls back only for an absent Server endpoint, never for revoked credentials",async()=>{
  const api=new API("https://example.test");vi.spyOn(api,"call").mockRejectedValueOnce(new APIError(404,"missing")).mockRejectedValueOnce(new APIError(401,"revoked"));
  expect(await api.controlChanges()).toBeUndefined();await expect(api.controlChanges()).rejects.toMatchObject({status:401});
});

it("retries an older input receipt without restoring its pre-stop running state",()=>{
  const reports=new ControlReports();
  const old:Snapshot={status:"active",messages:[],turnActive:true,commandId:"message",commandStatus:"delivered"};
  expect(reports.record("s",1,old).status).toBe("active");
  reports.record("s",2,{status:"idle",messages:[],turnActive:false,stopConfirmed:true,commandId:"stop",commandStatus:"delivered"});
  expect(reports.record("s",3,old)).toMatchObject({status:"idle",turnActive:false,commandId:"message",commandStatus:"delivered"});
  // A genuinely new input after the stop may start a new turn.
  expect(reports.record("s",4,{...old,commandId:"new"}).status).toBe("active");
});

it("keeps the latest failure on late receipts and drops it after recovery",()=>{
  const reports=new ControlReports();
  const old:Snapshot={status:"active",messages:[],commandId:"old",commandStatus:"delivered"};
  reports.record("s",1,old);
  const failure={code:"codex_server_error" as const,turnId:"failed-turn",detail:"Safe diagnostic"};
  reports.record("s",2,{status:"failed",messages:[],failure,commandId:"failed",commandStatus:"delivered"});
  expect(reports.record("s",3,old)).toMatchObject({status:"failed",failure});
  reports.record("s",4,{status:"idle",messages:[],commandId:"recovered",commandStatus:"delivered"});
  expect(reports.record("s",5,old).failure).toBeUndefined();
});

it("rejects a settled command's successful HTTP response as a new delivery reservation",async()=>{
  vi.spyOn(globalThis,"fetch").mockImplementation(async input=>String(input).includes("control-changes")
    ? Response.json({protocol:1,reservationProtocol:1,cursor:"fixture"})
    : new Response(null,{status:204,headers:{"x-missiongo-command-status":"delivered"}}));
  const api=new API("https://example.test");await api.controlChanges(undefined,0);
  await expect(api.call("POST","/api/v1/node/agent-sessions/session/snapshot",{status:"idle",messages:[],commandId:"command",commandStatus:"delivering"}))
    .rejects.toMatchObject({status:409});
});

it("uses the legacy lane when control v1 does not advertise reservation proofs", async()=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({protocol:1,cursor:"fixture"}));
  expect(await new API("https://example.test").controlChanges(undefined,0)).toBeUndefined();
});
