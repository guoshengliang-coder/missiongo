import { performance } from "node:perf_hooks";
import { firstPerformanceReply } from "@missiongo/domain";
import { ConsolePerformance, type PerformanceScope } from "./console-performance.js";

interface Send {scope:PerformanceScope;session:string;command:string;at:number;expires:number;received:boolean;turn?:string;done:boolean}
/** Only current-process monotonic intervals. IDs/turns are bounded transient correlation data. */
export class PerformanceSends {
 private pending=new Map<string,Send>();
 private bySession=new Map<string,Set<string>>();
 private firstSeen=new Map<string,{at:number;expires:number}>();
 private timer:ReturnType<typeof setInterval>;
 constructor(private readonly metrics:ConsolePerformance){this.timer=setInterval(()=>this.expire(),60000);this.timer.unref();}
 accept(scope:PerformanceScope,session:string,command:string,createdAt?:string){
  const key=`${session}:${command}`;if(this.pending.has(key))return;
  if(this.pending.size>=10000)this.expire();
  if(this.pending.size>=10000){this.metrics.record({id:`${command}:capacity`,scope,source:"server",version:this.metrics.version,stage:"missing",result:"unconfirmed"});return;}
  if(createdAt&&Date.now()-Date.parse(createdAt)>5000){this.metrics.record({id:`${command}:restart`,operation:command,scope,source:"server",version:this.metrics.version,stage:"missing",result:"uncorrelated"});return;}
  this.pending.set(key,{scope,session,command,at:performance.now(),expires:Date.now()+86400000,received:false,done:false});
  const entries=this.bySession.get(session)??new Set<string>();entries.add(key);this.bySession.set(session,entries);
  this.metrics.record({id:`${command}:accepted`,operation:command,scope,source:"server",version:this.metrics.version,stage:"logical_accepted",result:"success"});
 }
 bind(session:string,command:string,turn?:string){const p=this.pending.get(`${session}:${command}`);if(p&&turn&&!p.turn){p.turn=turn;const observed=this.firstSeen.get(`${session}:${turn}`);if(observed&&observed.at>=p.at&&!p.done){p.done=true;this.metrics.record({id:`${p.command}:agent_first_output`,operation:p.command,scope:p.scope,source:"server",version:this.metrics.version,stage:"agent_first_output",result:"success",durationMs:observed.at-p.at});}}}
 observe(session:string,command:string|undefined,status:string|undefined,messages:readonly {role:string;turnId?:string}[]){
  if(this.bySession.has(session))for(const m of messages)if((m.role==="agent"||m.role==="plan")&&m.turnId){const key=`${session}:${m.turnId}`;if(!this.firstSeen.has(key)&&this.firstSeen.size<10000)this.firstSeen.set(key,{at:performance.now(),expires:Date.now()+86400000});}
  for(const key of this.bySession.get(session)??[]){const p=this.pending.get(key);if(!p)continue;
   const record=(stage:"node_received"|"agent_first_output"|"missing",result:"success"|"unconfirmed")=>this.metrics.record({id:`${p.command}:${stage}`,operation:p.command,scope:p.scope,source:"server",version:this.metrics.version,stage,result,durationMs:performance.now()-p.at});
   if(p.command===command&&status==="delivering"&&!p.received){p.received=true;record("node_received","success");}
   if(!p.done&&firstPerformanceReply(messages,p.turn)){p.done=true;record("agent_first_output","success");}
   if(p.command===command&&["failed","delivery_unknown","cancelled"].includes(status??"")&&!p.done){p.done=true;record("missing","unconfirmed");}
  }
 }
 missing(session:string,command:string){const p=this.pending.get(`${session}:${command}`);if(p)p.done=true;}
 kind(session:string,command:string){return this.pending.get(`${session}:${command}`)?.scope.kind;}
 view(session:string){return [...(this.bySession.get(session)??[])].map(key=>this.pending.get(key)).filter((p):p is Send=>Boolean(p?.turn)).map(p=>({commandId:p.command,turnId:p.turn!})).slice(-32);}
 private expire(){for(const [key,p]of this.pending)if(p.expires<=Date.now()){
  if(!p.done)this.metrics.record({id:`${p.command}:expired`,operation:p.command,scope:p.scope,source:"server",version:this.metrics.version,stage:"missing",result:"expired"});this.pending.delete(key);const entries=this.bySession.get(p.session);entries?.delete(key);if(!entries?.size)this.bySession.delete(p.session);
 }for(const [key,value]of this.firstSeen)if(value.expires<=Date.now())this.firstSeen.delete(key);}
 close(){clearInterval(this.timer);this.pending.clear();this.bySession.clear();this.firstSeen.clear();}
}
