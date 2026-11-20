import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {createHash} from "node:crypto";
import {publicDownloadHash} from "./public-download.mjs";

async function server(t,handler){const s=createServer(handler);await new Promise(r=>s.listen(0,"127.0.0.1",r));t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${s.address().port}/package`;}
test("stream verification accepts slow ongoing data and hashes every byte",async t=>{
  const bytes=Buffer.from("complete-file".repeat(64));
  const url=await server(t,(_q,r)=>{r.writeHead(200,{"Content-Length":bytes.length});let n=0;const timer=setInterval(()=>{r.write(bytes.subarray(n,n+64));n+=64;if(n>=bytes.length){clearInterval(timer);r.end();}},20);r.on("close",()=>clearInterval(timer));});
  const result=await publicDownloadHash(url,{maxBytes:bytes.length,idleMs:500,totalMs:5000});
  assert.equal(result.bytes,bytes.length);assert.equal(result.sha256,createHash("sha256").update(bytes).digest("hex"));
});
test("idle timeout reports safe phase and progress without URL or credentials",async t=>{
  const url=await server(t,(_q,r)=>{r.writeHead(200);r.write("partial");});
  await assert.rejects(publicDownloadHash(url,{idleMs:100,totalMs:5000}),e=>e.message.includes('"code":"idle_timeout"')&&e.message.includes('"bytes":7')&&!e.message.includes("http"));
});
test("total time remains bounded even while data continues",async t=>{
  const url=await server(t,(_q,r)=>{r.writeHead(200);r.write("x");const timer=setInterval(()=>r.write("x"),10);r.on("close",()=>clearInterval(timer));});
  await assert.rejects(publicDownloadHash(url,{idleMs:500,totalMs:120}),/total_timeout/);
});
test("oversized and truncated responses never become successful proofs",async t=>{
  const big=await server(t,(_q,r)=>r.end("too much"));await assert.rejects(publicDownloadHash(big,{maxBytes:2}),/size_limit/);
  const short=await server(t,(_q,r)=>{r.writeHead(200,{"Content-Length":100});r.write("short");r.destroy();});
  await assert.rejects(publicDownloadHash(short),/Public download failed/);
});

for(const mode of ["oversized","http-error"])test(`early ${mode} rejection closes the body connection`,async t=>{
 let close;const closed=new Promise(resolve=>{close=resolve;});
 const url=await server(t,(_q,r)=>{
   r.writeHead(mode==="http-error"?500:200,{"Content-Length":1000000});r.write("x");
   const timer=setInterval(()=>r.write("x"),10);
   r.on("close",()=>{clearInterval(timer);close();});
 });
 await assert.rejects(publicDownloadHash(url,{maxBytes:2}),mode==="http-error"?/http_response/:/size_limit/);
 let timeout;try {await Promise.race([closed,new Promise((_resolve,reject)=>{timeout=setTimeout(()=>reject(new Error("Rejected download left its body connection open")),2000);})]);}finally{clearTimeout(timeout);}
});
