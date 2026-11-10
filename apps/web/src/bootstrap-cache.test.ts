import { expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { bootstrapCacheSeeder } from "./bootstrap-cache";
it("seeds initial restored resources but preserves concurrent writes even within the same millisecond",()=>{
 const client=new QueryClient();client.setQueryData(["products"],"restored");
 const seed=bootstrapCacheSeeder(client);seed(["products"],"initial fresh");expect(client.getQueryData(["products"])).toBe("initial fresh");
 const concurrent=bootstrapCacheSeeder(client);client.setQueryData(["products"],"newer");concurrent(["products"],"older");
 expect(client.getQueryData(["products"])).toBe("newer");client.clear();
});
it("refresh bootstrap cannot replace products, components or accumulated item pages",()=>{
 const client=new QueryClient();client.setQueryData(["bootstrap"],{user:{id:"account"}});
 const snapshots=[[["products"],{name:"new"}],[["components","p"],{name:"new"}],[["items","p"],{pages:[1,2],pageParams:[null,"next"]}]] as const;
 for(const [key,data] of snapshots)client.setQueryData(key,data);
 const seed=bootstrapCacheSeeder(client);
 for(const [key,data] of snapshots){seed(key,"old");expect(client.getQueryData(key)).toEqual(data);}
 client.clear();
});
it("never resurrects removed/replaced cache entries or overwrites a new resource read",()=>{
 const client=new QueryClient();client.setQueryData(["products"],"old");const seed=bootstrapCacheSeeder(client);
 client.removeQueries({queryKey:["products"]});seed(["products"],"resurrected");expect(client.getQueryData(["products"])).toBeUndefined();
 client.setQueryData(["products"],"new lifecycle");seed(["products"],"old lifecycle");expect(client.getQueryData(["products"])).toBe("new lifecycle");
 client.setQueryData(["components","p"],"new read");seed(["components","p"],"old initial");expect(client.getQueryData(["components","p"])).toBe("new read");client.clear();
});
