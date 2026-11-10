import { expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { retainSessionCache } from "./session-cache";
it("bounds detached conversation snapshots while retaining active content and clearing on account removal",async()=>{
 const client=new QueryClient(),stop=retainSessionCache(client,2,1000);
 const active=new QueryObserver(client,{queryKey:["agent-session","active"],enabled:false});const unsubscribe=active.subscribe(()=>{});
 client.setQueryData(["agent-session","active"],{text:"a".repeat(2000)});
 for(let i=0;i<4;i++)client.setQueryData(["agent-session",String(i)],{text:String(i)},{updatedAt:i+1});
 await Promise.resolve();expect(client.getQueryData(["agent-session","active"])).toBeDefined();
 expect(client.getQueriesData({queryKey:["agent-session"]})).toHaveLength(3);expect(client.getQueryData(["agent-session","0"])).toBeUndefined();
 client.clear();expect(client.getQueriesData({queryKey:["agent-session"]})).toEqual([]);stop();unsubscribe();
});
