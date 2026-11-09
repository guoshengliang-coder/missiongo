import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { changeAffects, EventFrames, startConsoleEvents } from "./console-events";
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
 vi.advanceTimersByTime(300_000);await settle();expect(read).not.toHaveBeenCalled();expect(f.fetcher).toHaveBeenCalledOnce();
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
