import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { selectPreloadImages,preloadArtifacts,ARTIFACT_PRELOAD_MAX_BYTES,ARTIFACT_PRELOAD_MAX_IMAGE } from "./artifact-preload";
import { retainArtifactCache } from "./artifact-cache";
import { api } from "./api";
const clients:QueryClient[]=[];
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();clients.splice(0).forEach(c=>c.clear());});
const client=()=>{const c=new QueryClient({defaultOptions:{queries:{retry:false}}});clients.push(c);return c;};
const image=(id:string,sizeBytes=100)=>({id,sessionId:"session",sizeBytes});
const bundle={entry:"image.png",files:[{name:"image.png",contentType:"image/png",base64:"aGVsbG8="}]};

it("reserves bytes, skips large/invalid/duplicate images and caps the count",()=>{
  const selected=selectPreloadImages([image("large",ARTIFACT_PRELOAD_MAX_IMAGE+1),image("invalid",NaN),image("empty",0),
    image("one",ARTIFACT_PRELOAD_MAX_IMAGE),image("one"),...Array.from({length:20},(_,i)=>image(String(i),ARTIFACT_PRELOAD_MAX_IMAGE))]);
  expect(selected).toHaveLength(ARTIFACT_PRELOAD_MAX_BYTES/ARTIFACT_PRELOAD_MAX_IMAGE);
  expect(new Set(selected.map(i=>i.id)).size).toBe(selected.length);
  expect(selectPreloadImages(Array.from({length:30},(_,i)=>image(String(i))))).toHaveLength(12);
});

it("starts at most two low-priority reads, reuses viewer cache, and cancels only detached work",async()=>{
  vi.useFakeTimers();const c=client();
  const signals:AbortSignal[]=[];const resolvers:Array<(value:typeof bundle)=>void>=[];
  const read=vi.spyOn(api,"agentArtifactBundle").mockImplementation((_session,_id,signal)=>{
    signals.push(signal!);return new Promise(resolve=>resolvers.push(resolve));
  });
  c.setQueryData(["artifact-bundle","session","cached"],bundle);
  const stop=preloadArtifacts(c,[image("cached"),image("one"),image("two"),image("three")]);
  expect(read).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(300);expect(read).toHaveBeenCalledTimes(2);
  resolvers[0]!(bundle);await vi.advanceTimersByTimeAsync(0);expect(read).toHaveBeenCalledTimes(3);
  const observer=new QueryObserver(c,{queryKey:["artifact-bundle","session","two"],enabled:false});const unsubscribe=observer.subscribe(()=>{});
  stop();expect(signals[1]!.aborted).toBe(false);expect(signals[2]!.aborted).toBe(true);
  resolvers[1]!(bundle);resolvers[2]!(bundle);await vi.advanceTimersByTimeAsync(0);
  expect(c.getQueryData(["artifact-bundle","session","one"])).toEqual(bundle);
  expect(c.getQueryData(["artifact-bundle","session","three"])).toBeUndefined();unsubscribe();
});

it("evicts idle bundles by count and byte size while retaining an opened image",async()=>{
  const c=client(),stop=retainArtifactCache(c,1,32);
  const observer=new QueryObserver(c,{queryKey:["artifact-bundle","s","open"],enabled:false});const unsubscribe=observer.subscribe(()=>{});
  c.setQueryData(["artifact-bundle","s","open"],{...bundle,files:[{...bundle.files[0]!,base64:"x".repeat(40)}]});
  c.setQueryData(["artifact-bundle","s","large"],{...bundle,files:[{...bundle.files[0]!,base64:"x".repeat(40)}]});
  c.setQueryData(["artifact-bundle","s","old"],bundle,{updatedAt:1});
  c.setQueryData(["artifact-bundle","s","new"],bundle,{updatedAt:2});
  await Promise.resolve();
  expect(c.getQueryData(["artifact-bundle","s","large"])).toBeUndefined();
  expect(c.getQueryData(["artifact-bundle","s","old"])).toBeUndefined();
  expect(c.getQueryData(["artifact-bundle","s","new"])).toEqual(bundle);
  expect(c.getQueryData(["artifact-bundle","s","open"])).toBeDefined();unsubscribe();stop();
});
