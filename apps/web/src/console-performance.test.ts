import { afterEach, expect, it, vi } from "vitest";
import { beginPerformanceSend, bindPerformanceSend, clearPerformanceSends, measurePerformance, observePerformanceReply } from "./console-performance";
afterEach(()=>{clearPerformanceSends();vi.useRealTimers();vi.unstubAllGlobals();});
it("telemetry failures do not await or repeat business requests, and same-turn history never substitutes for a binding",async()=>{
 vi.useFakeTimers();vi.stubGlobal("window",new EventTarget());vi.stubGlobal("document",{visibilityState:"visible"});
 const frames:FrameRequestCallback[]=[];vi.stubGlobal("requestAnimationFrame",(fn:FrameRequestCallback)=>frames.push(fn));
 const requests:any[]=[];vi.stubGlobal("fetch",vi.fn(async(_url:unknown,options?:RequestInit)=>{requests.push(JSON.parse(options!.body as string));throw new Error("offline");}));
 beginPerformanceSend("root",{sessionId:"session"});bindPerformanceSend("root","command","session");
 const business=vi.fn().mockResolvedValue("saved");expect(await measurePerformance({sessionId:"session"},"root","submit",business)).toBe("saved");expect(business).toHaveBeenCalledTimes(1);
 observePerformanceReply("session",[],[{role:"agent",turnId:"old"}]);expect(frames).toHaveLength(0);
 observePerformanceReply("session",[{commandId:"command",turnId:"new"}],[{role:"agent",turnId:"new"}]);expect(frames).toHaveLength(1);
 frames[0]!(0);await vi.advanceTimersByTimeAsync(500);expect(JSON.stringify(requests)).toContain("reply_visible");expect(business).toHaveBeenCalledTimes(1);
});
it("account clearing makes in-flight measurements and scheduled paint callbacks inert",async()=>{
 vi.useFakeTimers();vi.stubGlobal("window",new EventTarget());vi.stubGlobal("document",{visibilityState:"visible"});
 const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
 let complete!:(v:string)=>void;const task=measurePerformance({productId:"old-product"},"old","submit",()=>new Promise<string>(resolve=>{complete=resolve;}));
 clearPerformanceSends();complete("saved");await task;await vi.advanceTimersByTimeAsync(500);expect(fetcher).not.toHaveBeenCalled();
});

it("background waiting is separately observed and page-hidden output is not counted as visible",async()=>{
 vi.useFakeTimers();vi.stubGlobal("window",new EventTarget());
 const documentTarget=Object.assign(new EventTarget(),{visibilityState:"visible"});vi.stubGlobal("document",documentTarget);
 const requests:any[]=[];vi.stubGlobal("fetch",vi.fn(async(_url:unknown,options?:RequestInit)=>{requests.push(JSON.parse(options!.body as string));return new Response("{}",{status:202});}));
 const frames:FrameRequestCallback[]=[];vi.stubGlobal("requestAnimationFrame",(fn:FrameRequestCallback)=>frames.push(fn));
 beginPerformanceSend("hidden-root",{sessionId:"session"});bindPerformanceSend("hidden-root","command","session");
 documentTarget.visibilityState="hidden";documentTarget.dispatchEvent(new Event("visibilitychange"));
 observePerformanceReply("session",[{commandId:"command",turnId:"turn"}],[{role:"agent",turnId:"turn"}]);expect(frames).toEqual([]);
 await vi.advanceTimersByTimeAsync(1000);documentTarget.visibilityState="visible";documentTarget.dispatchEvent(new Event("visibilitychange"));
 await vi.advanceTimersByTimeAsync(500);expect(requests.flatMap(b=>b.events).some((e:any)=>e.stage==="background_wait")).toBe(true);
});
