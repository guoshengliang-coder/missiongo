import type { QueryClient } from "@tanstack/react-query";
import type { AgentArtifactBundle } from "@missiongo/domain";

/** Base64 strings occupy about twice their JSON size in JS. Keep only bounded idle copies. */
export function retainArtifactCache(client:QueryClient,maxEntries=12,maxBytes=16*1024*1024) {
  client.setQueryDefaults(["artifact-bundle"],{gcTime:5*60_000});
  let stopped=false,queued=false;
  const prune=()=>{
    queued=false;if(stopped)return;
    const queries=client.getQueryCache().findAll({queryKey:["artifact-bundle"]})
      .filter(q=>q.getObserversCount()===0 && q.state.fetchStatus==="idle")
      .sort((a,b)=>b.state.dataUpdatedAt-a.state.dataUpdatedAt);
    let count=0,bytes=0;
    for(const query of queries) {
      const bundle=query.state.data as AgentArtifactBundle|undefined;
      const size=bundle?.files?.reduce((total,file)=>total+file.base64.length*2,0) ?? 0;
      if(count>=maxEntries || bytes+size>maxBytes)client.removeQueries({queryKey:query.queryKey,exact:true});
      else {count++;bytes+=size;}
    }
  };
  const unsubscribe=client.getQueryCache().subscribe(event=>{
    if(event.query.queryKey[0]!=="artifact-bundle" || event.type==="removed" || queued)return;
    queued=true;queueMicrotask(prune);
  });
  return ()=>{stopped=true;unsubscribe();};
}
