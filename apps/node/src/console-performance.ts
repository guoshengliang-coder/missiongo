import { firstPerformanceReply, type ConsolePerformanceEvent } from "@missiongo/domain";
import type { Snapshot } from "./types.js";
export interface NativePerformanceReport {commandId:string;turnId?:string;events:ConsolePerformanceEvent[]}
/** Host-local monotonic timing. Never carries native transcript text to the collector. */
export class NativePerformance {
 private pending=new Map<string,{at:number;turn?:string;delivery?:number;done:boolean}>();
 begin(command:string){if(!this.pending.has(command)&&this.pending.size<256)this.pending.set(command,{at:performance.now(),done:false});}
 delivered(command:string,turn?:string){const p=this.pending.get(command);if(p){p.delivery=performance.now()-p.at;if(turn)p.turn=turn;}}
 reports(snapshot:Pick<Snapshot,"messages">):NativePerformanceReport[]{
  const reports:NativePerformanceReport[]=[];
  for(const [command,p]of this.pending){
   const events:ConsolePerformanceEvent[]=[];
   if(p.delivery!==undefined)events.push({id:`${command}:native`,stage:"native_delivery",result:"success",durationMs:p.delivery});
   if(p.turn&&firstPerformanceReply(snapshot.messages,p.turn)&&!p.done){p.done=true;events.push({id:`${command}:output`,stage:"agent_first_output",result:"success",durationMs:performance.now()-p.at});}
   if(p.delivery!==undefined&&!p.turn&&!p.done){p.done=true;events.push({id:`${command}:binding`,stage:"missing",result:"uncorrelated"});}
   if(performance.now()-p.at>86400000){events.push({id:`${command}:expired`,stage:"missing",result:"expired"});this.pending.delete(command);}
   if(events.length)reports.push({commandId:command,...(p.turn?{turnId:p.turn}:{}),events});
   // Completed timing may be retried through the next host response, never replay native input.
   if(p.done)this.pending.delete(command);
  }
  return reports;
 }
}

/** At most one network request and 256 queued batches, with finite retries. */
export class NativePerformanceUploader {
 private queue:{session:string;report:NativePerformanceReport;tries:number}[]=[];
 private running=false;
 private disabledUntil=0;
 constructor(private readonly send:(session:string,report:NativePerformanceReport)=>Promise<unknown>){}
 enqueue(session:string,report:NativePerformanceReport){
  if(this.queue.length>=256||Date.now()<this.disabledUntil)return;
  this.queue.push({session,report,tries:0});void this.drain();
 }
 private async drain(){
  if(this.running)return;this.running=true;
  try{while(this.queue.length){const p=this.queue.shift()!;try{await this.send(p.session,p.report);}catch(error){
   const status=error&&typeof error==="object"&&"status"in error?Number(error.status):0;
   if([401,403,404].includes(status)){this.disabledUntil=Date.now()+60000;this.queue=[];break;}
   if(++p.tries<3&&this.queue.length<256)this.queue.push(p);
  }}}finally{this.running=false;}
 }
}
