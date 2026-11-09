import type { ConsoleChangeResource } from "@missiongo/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ConsoleChanges, type ConsoleChange, type ConsoleChangeBatch } from "./console-changes.js";
import { invalidInput } from "./errors.js";

interface Access { accountId?: string; expiresAt: number; canRead: (change: ConsoleChange) => boolean }
/** A read-only stream. Its heartbeat writes bytes only; authorization is checked
 * on every committed batch and an expiry timer ends otherwise idle sessions. */
export function registerConsoleEvents(app: FastifyInstance, feed: ConsoleChanges,
 access: (request: FastifyRequest) => Access, key: (request: FastifyRequest) => string) {
 const connections = new Map<() => void, string>();
 const closeForKey = (value: string) => { for (const [close, candidate] of connections) if (candidate === value) close(); };
 app.get("/api/v1/console/events", async (request, reply) => {
  const initial=access(request);
  const query=request.query as {cursor?:string};
  const encoded=request.headers["last-event-id"] ?? query.cursor;
  if (typeof encoded !== "undefined" && (typeof encoded !== "string" || !/^[a-f0-9-]{36}:\d{1,16}$/.test(encoded))) throw invalidInput("Invalid change cursor.");
  let cursor=encoded ? Number(encoded.split(":")[1]) : feed.latest();
  if (!Number.isSafeInteger(cursor)) throw invalidInput("Invalid change cursor.");
  let reset=Boolean(encoded && !encoded.startsWith(`${feed.epoch}:`));
  let closed=false;
  let expires: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe=()=>{};
  const close=()=>{
   if (closed) return; closed=true;
   unsubscribe(); if (heartbeat) clearInterval(heartbeat); if (expires) clearTimeout(expires);
   connections.delete(close); reply.raw.end();
  };
  const send=(event:string,data:unknown,version?:number)=>{
   if(closed)return;
   const frame=`${version===undefined?"":`id: ${feed.epoch}:${version}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
   // Let slow clients resume from their last processed cursor; do not buffer forever.
   if (reply.raw.writableLength>256*1024) {close();return;}
   reply.raw.write(frame);
  };
  const flush=(batch?:ConsoleChangeBatch)=>{
   if(closed)return;
   // Private changes for another account cannot alter this connection's access.
   // Advance its cursor without doing account or journal queries.
   if(batch && cursor>=batch.after && cursor<=batch.page.version && !reset && !batch.page.reset && initial.accountId &&
      batch.page.changes.every(change=>change.account_id && change.account_id!==initial.accountId)) {
    cursor=batch.page.version;return;
   }
   let current:Access;
   try {current=access(request);} catch {send("unauthorized",{});close();return;}
   for(let count=0;count<21;count++) {
    const page=batch && cursor>=batch.after && cursor<=batch.page.version
     ? {...batch.page,changes:batch.page.changes.filter(change=>change.version>cursor),more:false}
     : feed.page(cursor);
    if(reset || page.reset) {
     cursor=feed.latest(); reset=false;
     send("reset",{version:cursor},cursor);return;
    }
    cursor=page.version;
    const unique=new Map<string,ConsoleChangeResource>();
    for(const change of page.changes) if(current.canRead(change)) {
     const resource={kind:change.kind,...(change.product_id?{productId:change.product_id}:{}),
      ...(change.item_key?{itemKey:change.item_key}:{}),...(change.resource_id?{resourceId:change.resource_id}:{})};
     unique.set(JSON.stringify(resource),resource);
    }
    if(unique.size) send("change",{version:cursor,resources:[...unique.values()]},cursor);
    if(!page.more)break;
   }
  };
  reply.hijack();
  for (const [name,value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(name,value);
  reply.raw.writeHead(200,{"content-type":"text/event-stream; charset=utf-8",
   "cache-control":"no-store", "x-accel-buffering":"no", "connection":"keep-alive"});
  connections.set(close,key(request));
  reply.raw.on("close",close); reply.raw.on("error",close);
  unsubscribe=feed.subscribe(flush);
  send("hello",{epoch:feed.epoch,version:cursor});
  // The subscription and replay are synchronous, so a write cannot fall between them.
  flush();
  heartbeat=setInterval(()=>{if(!closed)reply.raw.write(": keepalive\n\n");},25_000);heartbeat.unref();
  const expiry=()=>{
   const remaining=initial.expiresAt-Date.now();
   if(remaining<=0){send("unauthorized",{});close();return;}
   expires=setTimeout(expiry,Math.min(remaining,2_147_483_647));expires.unref();
  }; expiry();
  return reply;
 });
 app.addHook("preClose",async()=>{for(const close of connections.keys())close();});
 return {closeForKey};
}
