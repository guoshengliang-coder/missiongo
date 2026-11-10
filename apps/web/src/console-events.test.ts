import { bootstrapCacheSeeder } from "./bootstrap-cache";
import { consoleRefresh } from "./console-refresh";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { changeAffects, consoleConnectionSnapshot, EventFrames, startConsoleEvents } from "./console-events";
const cleanup:(()=>void)[]=[];
afterEach(()=>{cleanup.splice(0).forEach(fn=>fn());vi.unstubAllGlobals();vi.useRealTimers();});
const settle=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function fixture(initialCursor="epoch:0") {
 const windowTarget=new EventTarget(),documentTarget=Object.assign(new EventTarget(),{visibilityState:"visible"});
 vi.stubGlobal("window",windowTarget);vi.stubGlobal("document",documentTarget);vi.stubGlobal("navigator",{onLine:true});
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});cleanup.push(()=>client.clear());
 const streams:ReadableStreamDefaultController<Uint8Array>[]=[];
 const fetcher=vi.fn<typeof fetch>().mockImplementation(async(_url,options)=>{
  const stream=new ReadableStream<Uint8Array>({start(controller){streams.push(controller);options?.signal?.addEventListener("abort",()=>{try{controller.close();}catch{/* already ended */}});}});
  return new Response(stream,{headers:{"content-type":"text/event-stream"}});
 });
 const stop=startConsoleEvents(client,fetcher,initialCursor);cleanup.push(stop);
 const send=(event:string,data:unknown,id="epoch:1",stream=streams[0])=>stream!.enqueue(new TextEncoder().encode(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
 return {client,fetcher,send,streams,windowTarget,documentTarget};
}
it("parses split UTF-8 text, CRLF and multiline data without replaying comments",()=>{
 const parser=new EventFrames();expect(parser.push(": keepalive\r\n\r\nid: id:2\r\nevent: change\r\ndata: 中文")).toEqual([]);
 expect(parser.push("\r\ndata: second\r\n\r\n")).toEqual([{event:"change",id:"id:2",data:"中文\nsecond"}]);
});
it("invalidates only affected resources and covers both plan record views and pending results",()=>{
 expect(changeAffects(["items","p"],{kind:"item",productId:"other",itemKey:"OTHER-1"})).toBe(false);
 expect(changeAffects(["timeline","P-1"],{kind:"item",productId:"p",itemKey:"P-1"})).toBe(true);
 expect(changeAffects(["timeline","P-2"],{kind:"item",itemKey:"P-1"})).toBe(false);
 expect(changeAffects(["plan-record","s","revision"],{kind:"plan"})).toBe(true);
 expect(changeAffects(["artifact-state","s","a"],{kind:"artifact",resourceId:"s"})).toBe(true);
 expect(changeAffects(["agent-history-result","s","cursor"],{kind:"history",resourceId:"s"})).toBe(true);
});
it("does no idle polling and coalesces duplicate invalidations into refreshed state",async()=>{
 vi.useFakeTimers();const f=fixture();const read=vi.fn().mockResolvedValue({version:1});
 const observer=new QueryObserver(f.client,{queryKey:["timeline","P-1"],queryFn:read,staleTime:Infinity});cleanup.push(observer.subscribe(()=>{}));await settle();
 f.send("hello",{epoch:"epoch",version:0},"");await settle();read.mockClear();
 for(let i=0;i<12;i++){vi.advanceTimersByTime(25_000);f.streams[0]!.enqueue(new TextEncoder().encode(": keepalive\n\n"));await settle();}expect(read).not.toHaveBeenCalled();expect(f.fetcher).toHaveBeenCalledOnce();
 read.mockResolvedValue({version:2});
 const resources=[{kind:"item",productId:"p",itemKey:"P-1"}];
 f.send("change",{version:1,resources},"epoch:1");f.send("change",{version:1,resources},"epoch:1");
 await settle();expect(f.client.getQueryData(["timeline","P-1"])).toEqual({version:2});expect(read).toHaveBeenCalledOnce();
});
it("reconnects from the processed cursor and catches up a hidden page without losing a read in flight",async()=>{
 vi.useFakeTimers();const f=fixture("");await settle();f.send("hello",{epoch:"epoch",version:2},"");await settle();
 f.streams[0]!.close();await settle();vi.advanceTimersByTime(1000);await settle();
 expect(String(f.fetcher.mock.calls[1]?.[0])).toContain("epoch%3A2");
 f.documentTarget.visibilityState="hidden";f.documentTarget.dispatchEvent(new Event("visibilitychange"));await settle();
 vi.advanceTimersByTime(120_000);await settle();expect(f.fetcher).toHaveBeenCalledTimes(2);
 f.documentTarget.visibilityState="visible";f.documentTarget.dispatchEvent(new Event("visibilitychange"));await settle();expect(f.fetcher).toHaveBeenCalledTimes(3);
});
it("does not acknowledge a failed read and retains the invalidation for bounded retry",async()=>{
 vi.useFakeTimers();const f=fixture();let failed=false;
 const read=vi.fn(async()=>{if(failed)throw new Error("temporary");return "fresh";});
 const observer=new QueryObserver(f.client,{queryKey:["item","P-1"],queryFn:read,staleTime:Infinity});cleanup.push(observer.subscribe(()=>{}));await settle();
 f.send("hello",{epoch:"epoch",version:0},"");await settle();failed=true;
 f.send("change",{version:3,resources:[{kind:"item",itemKey:"P-1"}]},"epoch:3");await settle();
 f.streams[0]!.close();await settle();vi.advanceTimersByTime(1000);await settle();
 expect(String(f.fetcher.mock.calls[1]?.[0])).not.toContain("epoch%3A3");
 failed=false;vi.advanceTimersByTime(2000);await settle();expect(f.client.getQueryState(["item","P-1"])?.status).toBe("success");
});

it("refreshes again when a newer change arrives during an earlier snapshot read",async()=>{
 const f=fixture();let resolve:((value:string)=>void)|undefined;
 const read=vi.fn().mockResolvedValue("initial");
 const observer=new QueryObserver(f.client,{queryKey:["timeline","P-1"],queryFn:read,staleTime:Infinity});cleanup.push(observer.subscribe(()=>{}));await settle();
 f.send("hello",{epoch:"epoch",version:0},"");await settle();read.mockClear();
 read.mockImplementationOnce(()=>new Promise<string>(done=>{resolve=done;})).mockResolvedValue("latest");
 f.send("change",{version:1,resources:[{kind:"item",itemKey:"P-1"}]},"epoch:1");await settle();
 f.send("change",{version:2,resources:[{kind:"item",itemKey:"P-1"}]},"epoch:2");await settle();
 resolve!("older");await settle();
 expect(read).toHaveBeenCalledTimes(2);expect(f.client.getQueryData(["timeline","P-1"])).toBe("latest");
});
it("uses a bootstrap cursor without forcing an unnecessary initial snapshot read",async()=>{
 const f=fixture();cleanup.pop()!(); // Stop fixture's initial feed before testing a seeded feed.
 const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('event: hello\ndata: {"epoch":"epoch","version":9}\n\n'));}}),{headers:{"content-type":"text/event-stream"}}));
 const invalidate=vi.spyOn(f.client,"invalidateQueries");
 const stop=startConsoleEvents(f.client,fetcher,"epoch:9");cleanup.push(stop);await settle();
 expect(String(fetcher.mock.calls[0]?.[0])).toContain("epoch%3A9");expect(invalidate).not.toHaveBeenCalled();
});

it("evicts revoked snapshots and revalidates bootstrap after a journal reset",async()=>{
 const f=fixture();await settle();
 const read=vi.fn().mockResolvedValue({role:"member",products:[]});
 f.client.setQueryData(["bootstrap"],{role:"admin",products:["revoked"]});
 f.client.setQueryData(["item","SECRET-1"],{description:"old private content"});
 const bootstrap=new QueryObserver(f.client,{queryKey:["bootstrap"],queryFn:read,staleTime:Infinity});
 cleanup.push(bootstrap.subscribe(()=>{}));
 f.send("reset",{version:20000},"new-epoch:20000");await settle();
 expect(read).toHaveBeenCalledOnce();
 expect(f.client.getQueryData(["bootstrap"])).toEqual({role:"member",products:[]});
 expect(f.client.getQueryData(["item","SECRET-1"])).toBeUndefined();
});

it("ignores an already resolved unauthorized response after stream disposal",async()=>{
 const f=fixture();cleanup.pop()!();
 const stop=startConsoleEvents(f.client,async()=>new Response(null,{status:401}),"epoch:0");
 stop();f.client.setQueryData(["bootstrap"],{user:{id:"new-account"}});
 f.client.setQueryData(["item","NEW-1"],"new snapshot");await settle();
 expect(f.client.getQueryData(["item","NEW-1"])).toBe("new snapshot");
 expect(f.client.getQueryData(["bootstrap"])).toEqual({user:{id:"new-account"}});
});
it("ignores an obsolete unauthorized response when a newer connection is active",async()=>{
 const f=fixture();cleanup.pop()!();
 let finish:((value:Response)=>void)|undefined;
 const fetcher=vi.fn<typeof fetch>().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}))
  .mockResolvedValue(new Response(new ReadableStream(),{headers:{"content-type":"text/event-stream"}}));
 const stop=startConsoleEvents(f.client,fetcher,"epoch:0");cleanup.push(stop);
 f.documentTarget.visibilityState="hidden";f.documentTarget.dispatchEvent(new Event("visibilitychange"));
 f.documentTarget.visibilityState="visible";f.documentTarget.dispatchEvent(new Event("visibilitychange"));await settle();
 f.client.setQueryData(["item","NEW-1"],"current snapshot");
 finish!(new Response(null,{status:401}));await settle();
 expect(f.client.getQueryData(["item","NEW-1"])).toBe("current snapshot");
});

it("keeps chat refreshes independent of a slow delivery and retries only failed reads without reporting disconnection",async()=>{
 vi.useFakeTimers();const f=fixture();let release!:()=>void;
 const delivery=vi.fn().mockResolvedValue("initial"),chat=vi.fn().mockResolvedValue("chat");
 const d=new QueryObserver(f.client,{queryKey:["merge-deliveries","p"],queryFn:delivery,staleTime:Infinity});
 const c=new QueryObserver(f.client,{queryKey:["agent-session","s"],queryFn:chat,staleTime:Infinity});
 cleanup.push(d.subscribe(()=>{}),c.subscribe(()=>{}));await settle();chat.mockClear();delivery.mockClear();
 delivery.mockImplementationOnce(()=>new Promise<string>(resolve=>{release=()=>resolve("delivery");})).mockRejectedValue(new Error("read unavailable"));
 f.send("change",{resources:[{kind:"sessions"}]},"epoch:1");await settle();
 f.send("change",{resources:[{kind:"sessions"}]},"epoch:2");await settle();
 expect(chat).toHaveBeenCalledTimes(2);expect(delivery).toHaveBeenCalledOnce();expect(consoleConnectionSnapshot()).toBe("connected");
 release();await settle();expect(delivery).toHaveBeenCalledTimes(2);expect(consoleConnectionSnapshot()).toBe("connected");
 vi.advanceTimersByTime(1000);await settle();expect(delivery).toHaveBeenCalledTimes(3);expect(chat).toHaveBeenCalledTimes(2);
});
it("coalesces foreground/online/focus recovery without restarting a healthy stream or duplicating in-flight reads",async()=>{
 vi.useFakeTimers();const f=fixture();let release!:(v:string)=>void;
 const read=vi.fn().mockResolvedValue("cached");
 const observer=new QueryObserver(f.client,{queryKey:["agent-session","s"],queryFn:read,staleTime:Infinity});cleanup.push(observer.subscribe(()=>{}));await settle();
 f.client.setQueryData(["agent-session","s"],"cached",{updatedAt:Date.now()-120_000});
 read.mockClear();read.mockImplementation(()=>new Promise<string>(resolve=>{release=resolve;}));
 for(const event of ["focus","online","focus"])f.windowTarget.dispatchEvent(new Event(event));await settle();
 expect(f.fetcher).toHaveBeenCalledOnce();expect(read).toHaveBeenCalledOnce();release("fresh");await settle();expect(read).toHaveBeenCalledOnce();
});
it("reconnects a silent open stream but never polls business reads",async()=>{
 vi.useFakeTimers();const f=fixture();await settle();vi.advanceTimersByTime(60_000);await settle();
 expect(consoleConnectionSnapshot()).toBe("disconnected");vi.advanceTimersByTime(1000);await settle();expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it("bounds a stalled handshake and cleans up its deadline",async()=>{
 vi.useFakeTimers();const f=fixture();cleanup.pop()!();
 const fetcher=vi.fn<typeof fetch>().mockImplementation((_url,init)=>new Promise((_resolve,reject)=>init!.signal!.addEventListener("abort",()=>reject(new Error("aborted")))));
 const stop=startConsoleEvents(f.client,fetcher,"epoch:0");cleanup.push(stop);
 vi.advanceTimersByTime(15_000);await settle();expect(consoleConnectionSnapshot()).toBe("disconnected");
 vi.advanceTimersByTime(1000);await settle();expect(fetcher).toHaveBeenCalledTimes(2);stop();
 vi.advanceTimersByTime(60_000);await settle();expect(fetcher).toHaveBeenCalledTimes(2);
});
it("targets known conversation aliases and conservatively refreshes unknown identities",async()=>{
 const f=fixture();f.client.setQueryData(["agent-sessions","p"],{sessions:[{id:"canonical",agentSessionId:"canonical",relatedSessionIds:["external","native"]},{id:"other"}]});
 const current=vi.fn().mockResolvedValue("current"),other=vi.fn().mockResolvedValue("other");
 const a=new QueryObserver(f.client,{queryKey:["agent-session","canonical"],queryFn:current,staleTime:Infinity});
 const b=new QueryObserver(f.client,{queryKey:["agent-session","other"],queryFn:other,staleTime:Infinity});
 cleanup.push(a.subscribe(()=>{}),b.subscribe(()=>{}));await settle();current.mockClear();other.mockClear();
 f.send("change",{resources:[{kind:"sessions",resourceId:"external"}]},"epoch:1");await settle();
 expect(current).toHaveBeenCalledOnce();expect(other).not.toHaveBeenCalled();
 f.send("change",{resources:[{kind:"sessions",resourceId:"unknown"}]},"epoch:2");await settle();expect(other).toHaveBeenCalledOnce();
});
it("preempts a blocked read on access changes and ignores its late response",async()=>{
 const f=fixture();let finish!:(value:string)=>void;
 const read=vi.fn().mockResolvedValue("old");
 const observer=new QueryObserver(f.client,{queryKey:["agent-session","s"],queryFn:read,staleTime:Infinity});cleanup.push(observer.subscribe(()=>{}));await settle();
 read.mockImplementationOnce(()=>new Promise<string>(resolve=>{finish=resolve;})).mockResolvedValue("revoked");
 f.send("change",{resources:[{kind:"sessions"}]},"epoch:1");await settle();
 f.send("change",{resources:[{kind:"access"}]},"epoch:2");await settle();
 expect(f.client.getQueryData(["agent-session","s"])).toBe("revoked");finish("late secret");await settle();
 expect(f.client.getQueryData(["agent-session","s"])).toBe("revoked");
});
it("disposal cancels owned reads before a new lifecycle can reuse their keys",async()=>{
 const f=fixture();let finish!:(value:string)=>void;
 const read=vi.fn().mockResolvedValue("old");
 const observer=new QueryObserver(f.client,{queryKey:["agent-session","s"],queryFn:read,staleTime:Infinity});const unsubscribe=observer.subscribe(()=>{});await settle();
 read.mockImplementation(()=>new Promise<string>(resolve=>{finish=resolve;}));
 f.send("change",{resources:[{kind:"sessions"}]},"epoch:1");await settle();
 cleanup.pop()!();unsubscribe();f.client.setQueryData(["agent-session","s"],"new lifecycle");finish("late old content");await settle();
 expect(f.client.getQueryData(["agent-session","s"])).toBe("new lifecycle");
});

it("audit: a late bootstrap must not overwrite a newer resource snapshot",async()=>{
 const f=fixture();let finish!:()=>void;let serverVersion=0;
 const key=["products"];
 const products=new QueryObserver(f.client,{queryKey:key,initialData:0,staleTime:Infinity,queryFn:async()=>++serverVersion});
 const bootstrap=new QueryObserver(f.client,{queryKey:["bootstrap"],initialData:"initial bootstrap",staleTime:Infinity,queryFn:async()=>{
  const seed=bootstrapCacheSeeder(f.client);
  const captured=serverVersion;
  await new Promise<void>(resolve=>{finish=resolve;});
  // Same cache seeding performed by App.tsx after getBootstrap resolves.
  seed(key,captured);return "bootstrap";
 }});
 cleanup.push(products.subscribe(()=>{}),bootstrap.subscribe(()=>{}));
 const refresh=consoleRefresh(f.client,()=>{});cleanup.push(refresh.stop);
 await refresh.reset();await settle();
 expect(f.client.getQueryData(key)).toBe(1);
 finish();await settle();
 expect(f.client.getQueryData(key)).toBe(1);
});
it("audit: a newly merged identity must refresh the existing canonical transcript",async()=>{
 const f=fixture();
 const old={sessions:[{id:"a",agentSessionId:"a"},{id:"b",agentSessionId:"b"}]};
 const merged={sessions:[{id:"a",agentSessionId:"a",relatedSessionIds:["a","b"]}]};
 const list=new QueryObserver(f.client,{queryKey:["agent-sessions"],initialData:old,staleTime:Infinity,queryFn:async()=>merged});
 const read=vi.fn().mockResolvedValue("merged transcript");
 const detail=new QueryObserver(f.client,{queryKey:["agent-session","a"],initialData:"old transcript",staleTime:Infinity,queryFn:read});
 cleanup.push(list.subscribe(()=>{}),detail.subscribe(()=>{}));await settle();
 f.send("change",{resources:[{kind:"sessions",resourceId:"b"}]},"epoch:1");await settle();
 expect(f.client.getQueryData(["agent-sessions"])).toEqual(merged);
 expect(f.client.getQueryData(["agent-session","a"])).toBe("merged transcript");
});
it("reconciles identity after an independent list retry and preserves stable-list targeting",async()=>{
 vi.useFakeTimers();const f=fixture();let fail=true;
 f.client.setQueryData(["agent-sessions"],{sessions:[{id:"a"},{id:"b"}]});
 const list=new QueryObserver(f.client,{queryKey:["agent-sessions"],staleTime:Infinity,queryFn:async()=>{
  if(fail)throw new Error("temporary list failure");return {sessions:[{id:"a",relatedSessionIds:["a","b"]}]};
 }});
 const read=vi.fn().mockResolvedValue("merged");const detail=new QueryObserver(f.client,{queryKey:["agent-session","a"],initialData:"old",staleTime:Infinity,queryFn:read});
 const delivery=vi.fn().mockResolvedValue("offer");const scoped=new QueryObserver(f.client,{queryKey:["merge-deliveries","p","a"],initialData:"old offer",staleTime:Infinity,queryFn:delivery});
 cleanup.push(list.subscribe(()=>{}),detail.subscribe(()=>{}),scoped.subscribe(()=>{}));
 f.send("change",{resources:[{kind:"sessions",resourceId:"b"}]},"epoch:1");await settle();expect(read).not.toHaveBeenCalled();
 fail=false;vi.advanceTimersByTime(1000);await settle();expect(read).toHaveBeenCalledOnce();expect(delivery).toHaveBeenCalledOnce();
 f.client.setQueryData(["agent-sessions"],{sessions:[{id:"a",relatedSessionIds:["b","a"],latestMessage:"activity only"}]});await settle();expect(read).toHaveBeenCalledOnce();
});
it("a stopped refresh scheduler does not accept new invalidations",async()=>{
 const f=fixture();f.client.setQueryData(["agent-session","a"],"cached");
 const refresh=consoleRefresh(f.client,()=>{});refresh.stop();
 const invalidation=vi.spyOn(f.client,"invalidateQueries");refresh.add(f.client.getQueryCache().getAll());await settle();
 expect(invalidation).not.toHaveBeenCalled();
});
