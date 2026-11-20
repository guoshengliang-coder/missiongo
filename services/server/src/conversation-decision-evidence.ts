import {AgentHistory} from "./agent-history.js";
import {AgentArtifacts} from "./agent-artifacts.js";
import type {MissionGoDatabase} from "./storage/database.js";
import type {AgentSessionMessageInput as Message} from "./agent-session-store.js";

/** Read authenticated source history, never an Agent-supplied transcript or approval flag. */
export function conversationDecisionEvidence(database:MissionGoDatabase,accountId:string,sessionId:string,text:string,requestedAt:string) {
  const db=database.connection;
  const binding=db.prepare(`SELECT s.node_id,s.agent_session_ref AS ref,s.dispatch_id,s.agent_kind FROM agent_sessions s
    JOIN dispatches d ON d.id=s.dispatch_id JOIN nodes n ON n.id=s.node_id
    WHERE s.id=? AND d.account_id=? AND n.account_id=? AND n.revoked_at IS NULL AND s.archived_at IS NULL
    AND s.agent_kind IN ('codex','claude_code','opencode') AND d.status IN ('launched','delivered')`)
    .get(sessionId,accountId,accountId) as {node_id:string;ref:string;dispatch_id:string;agent_kind:string}|undefined;
  if(!binding)return {code:"identity_unavailable" as const};
  const history=new AgentHistory(database,new AgentArtifacts(database,""));
  if(!["complete","ready"].includes(history.available(accountId,sessionId).status)||history.incomplete(accountId,sessionId))return {code:"history_incomplete" as const};
  const size=db.prepare("SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(text AS BLOB))),0) AS bytes FROM agent_session_messages WHERE session_id=?").get(sessionId) as {n:number;bytes:number};
  const pages=db.prepare("SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(result_json AS BLOB))),0) AS bytes FROM agent_history_pages WHERE account_id=? AND session_id=? AND status='ready'").get(accountId,sessionId) as {n:number;bytes:number};
  if(size.n>10000||size.bytes>32*1024*1024||pages.n>512||pages.bytes>32*1024*1024)return {code:"history_incomplete" as const};
  const cached=history.cachedMessages(accountId,sessionId);
  const current=db.prepare(`SELECT source_id AS sourceId,turn_id AS turnId,role,phase,text,occurred_at AS occurredAt,questions_json AS questionsJson
    FROM agent_session_messages WHERE session_id=? ORDER BY position,observed_at,rowid`).all(sessionId) as unknown as (Message&{questionsJson:string|null})[];
  if(cached.length+current.length>10000||Buffer.byteLength(JSON.stringify(cached))>32*1024*1024)return {code:"history_incomplete" as const};
  const unique=new Map<string,Message>();
  for(const m of [...cached,...current.map(({questionsJson,...m})=>({...m,...(questionsJson?{questions:JSON.parse(questionsJson)}:{})}))]){
    if(m.phase==="execution")continue;
    if(!m.sourceId||!m.occurredAt||!Number.isFinite(Date.parse(m.occurredAt)))return {code:"history_incomplete" as const};
    const prior=unique.get(m.sourceId);
    const fingerprint=(v:Message)=>JSON.stringify([v.role,v.text,v.phase??null,v.turnId??null,v.questions??[],Date.parse(v.occurredAt!)]);
    if(prior&&fingerprint(prior)!==fingerprint(m))return {code:"source_conflict" as const};
    unique.set(m.sourceId,m);
  }
  const messages=[...unique.values()].sort((a,b)=>Date.parse(a.occurredAt!)-Date.parse(b.occurredAt!));
  const displays=messages.filter(m=>m.role!=="user"&&m.phase==="final_answer"&&m.text===text&&!m.questions?.length&&Date.parse(m.occurredAt!)>=Date.parse(requestedAt));
  if(displays.length!==1)return {code:"evidence_missing" as const};
  const display=displays[0]!,index=messages.indexOf(display),acceptance=messages.slice(index+1).find(m=>m.role==="user");
  if(!acceptance||!["同意","批准","不同意","拒绝"].includes(acceptance.text)||acceptance.sourceId===display.sourceId||Date.parse(acceptance.occurredAt!)<=Date.parse(display.occurredAt!)
    ||display.turnId&&acceptance.turnId&&display.turnId===acceptance.turnId
    ||binding.agent_kind==="codex"&&(!display.turnId||!acceptance.turnId)
    ||messages.slice(index+1,messages.indexOf(acceptance)).some(m=>m.phase==="final_answer"||m.role==="plan"||m.questions?.length))return {code:"evidence_missing" as const};
  for(const m of [display,acceptance]){
    if(cached.some(c=>c.sourceId===m.sourceId&&c.occurredAt===m.occurredAt))continue;
    const clock=db.prepare("SELECT occurred_at FROM session_message_times WHERE session_key=? AND source_id=? AND provenance='source_message'")
      .get(`dispatch:${binding.dispatch_id}`,`native:${m.sourceId}`) as {occurred_at:string}|undefined;
    if(!clock||Date.parse(clock.occurred_at)!==Date.parse(m.occurredAt!))return {code:"history_incomplete" as const};
  }
  return {code:"ready_to_restore" as const,sourceId:acceptance.sourceId,decision:["同意","批准"].includes(acceptance.text)?"approved" as const:"rejected" as const};
}
