import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { MissionGoStore } from "./store.js";
import { DispatchStore } from "./dispatch-store.js";
import { StatusCheckHistory } from "./status-check-history.js";
import { deliveryRound } from "./delivery-round.js";

let app: FastifyInstance | undefined;
let directory: string | undefined;
afterEach(async () => {
  await app?.close(); app=undefined;
  if (directory) await rm(directory,{recursive:true,force:true}); directory=undefined;
  vi.useRealTimers();
});

it("keeps persisted queues inert after restart, rejects old leases, and preserves history", async () => {
  vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime("2026-11-04T05:00:00Z");
  directory=await mkdtemp(join(tmpdir(),"missiongo-retired-checks-"));
  const databasePath=join(directory,"test.sqlite"), store=new MissionGoStore(databasePath);
  const product=store.createProduct({name:"Retirement",keyPrefix:"RET"});
  const item=store.createWorkItem({productId:product.id,title:"Keep my decision",description:"Body",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}});
  store.claimWorkItem({itemKey:item.key,agentId:"test",idempotencyKey:"claim"});
  const node=new DispatchStore(store.database).registerNode({accountId:"owner",installationId:"retirement-node",name:"Node"});
  const handoverId=randomUUID(),leaseToken=randomUUID(),now=new Date().toISOString(),commit="a".repeat(40);
  store.database.connection.prepare(`INSERT INTO status_handovers
    (id,item_id,account_id,round_key,pull_request_url,required_json,evidence_json,check_status,requested_at,lease_token,lease_node_id,lease_until,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(handoverId,item.id,"owner",deliveryRound(store.database,item.id),"https://github.com/example/project/pull/1",'["web"]',JSON.stringify({merged:{commit,occurredAt:now}}),"checking",now,leaseToken,node.nodeId,"2026-11-05T00:00:00Z",now,now);
  const history=store.getTimeline(item.key),queued=store.database.connection.prepare("SELECT * FROM status_handovers").all();
  store.close();
  // Even an old explicit schedule setting cannot bring the removed feature back.
  app=buildApp({databasePath,attachmentsPath:join(directory,"attachments"),statusCheckTime:"00:00"});
  await app.ready();
  const headers={authorization:`Bearer ${node.token}`};
  for(const path of ["status-checks","completion-discovery"]) {
    expect((await app.inject({method:"POST",url:`/api/v1/node/${path}/claim`,headers,payload:{supportsSharedReleases:true}})).json()).toEqual({job:null});
    expect((await app.inject({method:"POST",url:`/api/v1/node/${path}/${handoverId}/report`,headers,payload:{leaseToken,evidence:{merged:{commit,occurredAt:now}}}})).statusCode).toBe(410);
    expect((await app.inject({method:"POST",url:`/api/v1/node/${path}/claim`,payload:{}})).statusCode).toBe(401);
  }
  const beat=await app.inject({method:"POST",url:"/api/v1/node/heartbeat",headers,payload:{agents:[]}});
  expect(beat.json()).toMatchObject({supportsStatusChecks:false});
  expect(app.missionGoStore.getWorkItem(item.key)).toMatchObject({status:"in_progress"});
  expect(app.missionGoStore.getWorkItem(item.key).deliveryProgress).toBeUndefined();
  expect(new StatusCheckHistory(app.missionGoStore).list(product.id).items).toMatchObject([
    {id:handoverId,status:"retired",historicalStatus:"checking",requestedAt:null,historicalRequestedAt:now},
  ]);
  expect(app.missionGoStore.getTimeline(item.key)).toEqual(history);
  expect(app.missionGoStore.database.connection.prepare("SELECT * FROM status_handovers").all()).toEqual(queued);
  expect(app.missionGoStore.database.connection.prepare("SELECT * FROM status_check_days").all()).toEqual([]);
});
