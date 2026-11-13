declare const MISSIONGO_PERFORMANCE_BUILD:string;
import { firstPerformanceReply, type ConsolePerformanceEvent, type PerformanceStage, type PerformanceResult } from "@missiongo/domain";

type Context = {sessionId:string}|{productId:string;agentKind?:string;sendKind?:string};
type Pending = {context:Context;event:ConsolePerformanceEvent;tries:number};
const queue:Pending[]=[];
const sends=new Map<string,{context:Context;at:number;command?:string;session?:string;expires:number;hiddenAt?:number;hiddenSequence:number}>();
let generation=0;
let expiryTimer:ReturnType<typeof setInterval>|undefined;
let visibilityDocument:Document|undefined;
function expireSends(){for(const [key,p]of sends)if(p.expires<Date.now()){emitPerformance(p.context,`${key}:expired`,"missing","expired");sends.delete(key);}if(!sends.size&&expiryTimer){clearInterval(expiryTimer);expiryTimer=undefined;}}
function visibilityChanged(){const at=performanceNow();for(const [root,p]of sends){if(document.visibilityState==="hidden"){p.hiddenAt??=at;}else if(p.hiddenAt!==undefined){emitPerformance(p.context,`${root}:hidden-${p.hiddenSequence++}`,"background_wait","hidden",at-p.hiddenAt);delete p.hiddenAt;}}}
function trackVisibility(){
 if(typeof document!=="undefined"&&typeof document.addEventListener==="function"&&visibilityDocument!==document){visibilityDocument?.removeEventListener("visibilitychange",visibilityChanged);visibilityDocument=document;document.addEventListener("visibilitychange",visibilityChanged);}
 if(!expiryTimer){expiryTimer=setInterval(expireSends,60000);}
}
let timer:ReturnType<typeof setTimeout>|undefined,running=false,disabledUntil=0;
export const performanceNow=()=>typeof performance==="undefined"?0:performance.now();
export function performanceResult(error:unknown):PerformanceResult {
 if(error instanceof DOMException && ["TimeoutError","AbortError"].includes(error.name))return "timeout";
 if(error&&typeof error==="object"&&"status"in error&&Number((error as {status:unknown}).status)>=400)return "rejected";
 return "network_failure";
}
export function emitPerformance(context:Context,id:string,stage:PerformanceStage,result:PerformanceResult="success",durationMs?:number){
 if(typeof window==="undefined"||queue.length>=256||Date.now()<disabledUntil)return;
 queue.push({context,event:{id,stage,result,...(durationMs===undefined?{}:{durationMs:Math.min(86400000,Math.max(0,durationMs))})},tries:0});
 if(!timer)timer=setTimeout(()=>{timer=undefined;void flush();},500);
}
async function flush(){
 if(running||!queue.length)return;running=true;
 const epoch=generation,first=queue.shift()!,batch=[first];
 for(let i=0;i<queue.length&&batch.length<32;)if(JSON.stringify(queue[i]!.context)===JSON.stringify(first.context))batch.push(queue.splice(i,1)[0]!);else i++;
 try{
  const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),3000);
  let response:Response;try{response=await fetch("/api/v1/console/performance",{method:"POST",credentials:"same-origin",signal:controller.signal,headers:{"content-type":"application/json"},body:JSON.stringify({...first.context,version:typeof MISSIONGO_PERFORMANCE_BUILD==="string"?MISSIONGO_PERFORMANCE_BUILD:"development",events:batch.map(p=>p.event)})});}finally{clearTimeout(deadline);}
  if(epoch!==generation)return;
  if([401,403,404].includes(response.status)){disabledUntil=Date.now()+60000;queue.length=0;}
  else if(!response.ok)throw new Error("Collection unavailable");
 }catch{for(const p of batch)if(epoch===generation&&++p.tries<3&&queue.length<256)queue.push(p);}
 finally{running=false;if(queue.length&&!timer)timer=setTimeout(()=>{timer=undefined;void flush();},2000);}
}
export function beginPerformanceSend(root:string,context:Context){
 if(typeof window==="undefined")return;
 expireSends();
 if(sends.has(root)||sends.size>=256)return;
 sends.set(root,{context,at:performanceNow(),expires:Date.now()+86400000,hiddenSequence:0,...(typeof document!=="undefined"&&document.visibilityState==="hidden"?{hiddenAt:performanceNow()}:{})});trackVisibility();emitPerformance(context,`${root}:begin`,"send_started");
}
export function bindPerformanceSend(root:string,command:string,session:string){const p=sends.get(root);if(p){p.command=command;p.session=session;}}
export function clearPerformanceSends(){generation++;disabledUntil=0;sends.clear();queue.length=0;if(timer)clearTimeout(timer);timer=undefined;if(expiryTimer)clearInterval(expiryTimer);expiryTimer=undefined;visibilityDocument?.removeEventListener("visibilitychange",visibilityChanged);visibilityDocument=undefined;}
export async function measurePerformance<T>(context:Context,root:string,stage:PerformanceStage,operation:()=>Promise<T>):Promise<T>{
 const at=performanceNow(),id=crypto.randomUUID(),epoch=generation;
 try{const value=await operation();if(epoch!==generation)return value;emitPerformance(context,`${root}:${id}:http`,"http_attempt");emitPerformance(context,`${root}:${id}`,stage,"success",performanceNow()-at);return value;}
 catch(error){if(epoch!==generation)throw error;const result=performanceResult(error);emitPerformance(context,`${root}:${id}:http`,"http_attempt",result);emitPerformance(context,`${root}:${id}`,stage,result,performanceNow()-at);throw error;}
}
/** Called after React commits; the next paint opportunity is an approximation, not physical display time. */
export function observePerformanceReply(session:string,turns:readonly {commandId:string;turnId:string}[],messages:readonly {role:string;turnId?:string;historical?:boolean}[]){
 for(const [root,p]of sends)if(p.session===session&&p.command){
  const turn=turns.find(t=>t.commandId===p.command);
  if(!firstPerformanceReply(messages,turn?.turnId))continue;
  if(document.visibilityState!=="visible")continue;
  sends.delete(root);expireSends();const epoch=generation;
  requestAnimationFrame(()=>{if(epoch!==generation)return;if(document.visibilityState!=="visible"){emitPerformance(p.context,`${root}:visible`,"missing","hidden");return;}emitPerformance(p.context,`${root}:visible`,"reply_visible","success",performanceNow()-p.at);});
 }
}
