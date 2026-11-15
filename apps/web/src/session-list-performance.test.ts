import { afterEach, beforeEach, expect, it, vi } from "vitest";
const capture=vi.hoisted(()=>({events:[] as any[][],epoch:0}));
vi.mock("./console-performance",()=>({emitPerformance:(...args:any[])=>capture.events.push(args),performanceGeneration:()=>capture.epoch,performanceNow:()=>performance.now(),performanceResult:()=>"network_failure"}));
import { startListVisit,endListVisit,commitList,measureSessionListRequest,shareSessionListData,clearSessionListPerformance,listDevice,noteListIntent } from "./session-list-performance";
let frames:FrameRequestCallback[]=[];
beforeEach(()=>{
 capture.events=[];frames=[];vi.stubGlobal("window",new EventTarget());vi.stubGlobal("document",{visibilityState:"visible"});
 vi.stubGlobal("navigator",{userAgent:"Synthetic Android Mobile",maxTouchPoints:1});vi.stubGlobal("location",{origin:"https://synthetic.invalid"});
 vi.stubGlobal("requestAnimationFrame",(fn:FrameRequestCallback)=>frames.push(fn));
});
afterEach(()=>{clearSessionListPerformance();vi.unstubAllGlobals();});
const drain=()=>{for(const f of frames.splice(0))f(0);};
const events=(stage:string)=>capture.events.filter(e=>e[2]===stage);
it("does not turn cache-only visits or project switching into refresh failures or extra visits",()=>{
 const data=[{}];startListVisit(data,false);commitList(data,"product-a",1,true);commitList(data,"product-b",0,true);drain();
 expect(events("list_visit")).toHaveLength(1);expect(events("list_view")).toHaveLength(2);expect(events("list_view")[0]![5].rows).toBeUndefined();
 expect(events("list_entry_fresh_visible")[0]![3]).toBe("no_refresh");
 expect(capture.events.some(e=>e[3]==="timeout")).toBe(false);
 endListVisit();expect(events("list_visit_end")[0]![5].requests).toBe(0);
});
it("keeps equal-data network responses observable without disabling normal structural sharing",async()=>{
 const data=[{value:1}];startListVisit(data,false);
 const call=vi.fn(async()=>({sessions:[{value:1}]}));
 const response=await measureSessionListRequest(call);
 const shared=shareSessionListData({sessions:data},response) as typeof response;expect(shared.sessions).toBe(data);
 commitList(shared.sessions,"product",1,true);drain();
 expect(events("list_request")).toHaveLength(1);expect(events("list_fresh_visible")).toHaveLength(1);
 commitList(shared.sessions,"product",1,true);drain();expect(events("list_fresh_visible")).toHaveLength(1);
 endListVisit();expect(events("list_visit_end")[0]![5]).toMatchObject({requests:1,refreshes:1});expect(call).toHaveBeenCalledTimes(1);
});
it("joins existing requests explicitly, and ignores late paints or reads after a visit ends",async()=>{
 let resolve!:(v:{sessions:object[]})=>void;
 const promise=measureSessionListRequest(()=>new Promise<{sessions:object[]}>(r=>{resolve=r;}));
 startListVisit(undefined,true);
 resolve({sessions:[{}]});const value=await promise;commitList(value.sessions,"product",1,true);drain();
 expect(events("list_entry_fresh_visible")[0]![3]).toBe("inflight_at_entry");expect(events("list_fresh_visible")).toHaveLength(0);
 endListVisit("hidden");startListVisit(value.sessions,false,true);endListVisit("cancelled");drain();
 expect(events("list_cache_visible").filter(e=>e[3]==="success")).toHaveLength(0);
 expect(events("list_visit").at(-1)![5].scenario).toBe("background_resume");
});
it("account generation changes discard late results; failed collection cannot repeat the business operation",async()=>{
 startListVisit(undefined,false);
 let resolve!:(v:{sessions:object[]})=>void;const operation=vi.fn(()=>new Promise<{sessions:object[]}>(r=>{resolve=r;}));
 const pending=measureSessionListRequest(operation);capture.epoch++;clearSessionListPerformance();resolve({sessions:[]});await pending;
 expect(events("list_request")).toHaveLength(0);expect(operation).toHaveBeenCalledTimes(1);
 const failure=vi.fn().mockRejectedValue(new Error("network"));await expect(measureSessionListRequest(failure)).rejects.toThrow("network");expect(failure).toHaveBeenCalledTimes(1);
});
it("does not infer phones from viewport width or call tablets PCs",()=>{
 vi.stubGlobal("navigator",{userAgent:"Synthetic Desktop X11",maxTouchPoints:0});expect(listDevice()).toBe("pc");
 vi.stubGlobal("navigator",{userAgent:"Macintosh",maxTouchPoints:5});expect(listDevice()).toBe("unknown");
 vi.stubGlobal("navigator",{userAgent:"unrecognized",maxTouchPoints:1});expect(listDevice()).toBe("unknown");
 expect(capture.events).toEqual([]);
});

it("resuming uses a new monotonic origin even when an earlier navigation intent exists",()=>{
 const clock=vi.spyOn(performance,"now").mockReturnValue(0),data=[{}];
 startListVisit(data,false);drain();clock.mockReturnValue(40);noteListIntent();
 clock.mockReturnValue(200);endListVisit("hidden");clock.mockReturnValue(500);startListVisit(data,false,true);
 clock.mockReturnValue(600);drain();
 expect(events("list_cache_visible").at(-1)![4]).toBe(100);clock.mockRestore();
});
