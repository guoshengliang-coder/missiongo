import { createHash } from "node:crypto";

/** Bounded, streaming public verification. Diagnostics never contain URLs or headers. */
export async function publicDownloadHash(url,{maxBytes=512*1024*1024,totalMs=600000,idleMs=60000,fetcher=fetch}={}) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<=0||totalMs<=0||idleMs<=0)throw new Error("Invalid public download limits");
  const started=Date.now(),controller=new AbortController();let bytes=0,phase="response",reason;
  const abort=code=>{reason=code;controller.abort();};
  const total=setTimeout(()=>abort("total_timeout"),totalMs);
  let idle=setTimeout(()=>abort("idle_timeout"),idleMs);
  const reset=()=>{clearTimeout(idle);idle=setTimeout(()=>abort("idle_timeout"),idleMs);};
  try {
    const response=await fetcher(url,{redirect:"error",signal:controller.signal});
    if(!response.ok||!response.body){reason="http_response";throw new Error("HTTP response failed");}
    const length=response.headers.get("content-length");
    if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maxBytes)){reason="size_limit";throw new Error("Content length exceeds limit");}
    phase="body";reset();const hash=createHash("sha256");
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>maxBytes){reason="size_limit";controller.abort();throw new Error("Content exceeds limit");}hash.update(chunk);reset();}
    if(length!==null&&bytes!==Number(length)){reason="truncated";throw new Error("Incomplete content");}
    return {sha256:hash.digest("hex"),bytes,elapsedMs:Date.now()-started};
  }catch{
    throw new Error(`Public download failed: ${JSON.stringify({code:reason??"network",phase,bytes,elapsedMs:Date.now()-started})}`);
  }finally{clearTimeout(total);clearTimeout(idle);}
}
