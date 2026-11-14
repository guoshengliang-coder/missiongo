import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:worker_threads",async()=>{
 const {EventEmitter}=await import("node:events");
 class Worker extends EventEmitter {
  constructor(){super();queueMicrotask(()=>this.emit("message",{kind:"ready"}));}
  unref(){} postMessage(){} async terminate(){return 0;}
 }
 return {Worker};
});
import { ConsolePerformance } from "./console-performance.js";
afterEach(()=>vi.useRealTimers());
it("a first event after a long idle period receives its own timeout, then a stalled worker fails closed",async()=>{
 vi.useFakeTimers();const m=new ConsolePerformance(":memory:","fixture",true);
 try {
  await Promise.resolve();await vi.advanceTimersByTimeAsync(60000);expect(m.status().ready).toBe(true);
  m.record({id:"after-idle",scope:{account:"owner",products:[]},source:"server",version:"fixture",stage:"submit",result:"success"});
  await vi.advanceTimersByTimeAsync(1000);expect(m.status().ready).toBe(true);
  await vi.advanceTimersByTimeAsync(6000);expect(m.status().degraded).toBe(true);
 }finally{await m.close();}
});
