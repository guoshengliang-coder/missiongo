import { ConsoleChanges } from "./console-changes.js";
import { afterEach, expect, it } from "vitest";
import { MissionGoStore } from "./store.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { developmentReviewSummary, developmentReviewBlocker, recordDevelopmentReviews, sessionDevelopmentReviews } from "./development-reviews.js";
import type { DevelopmentReviewEvidence } from "@missiongo/domain";
const stores: MissionGoStore[]=[];
afterEach(()=>stores.splice(0).forEach(s=>s.close()));
function fixture() {
  const store=new MissionGoStore(":memory:");stores.push(store);
  const db=store.database,now=new Date().toISOString();
  db.connection.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at)
    VALUES ('node','owner','installation','Fixture','synthetic','[]',?,?,?)`).run(now,now,now);
  db.connection.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,unread_at)
    VALUES ('dispatch','owner','node','codex','default','launched','fixture',?,?)`).run(now,now);
  const session=new AgentSessionStore(db).createForDispatch({dispatchId:"dispatch",nodeId:"node",sessionRef:"native"});
  const value:DevelopmentReviewEvidence={version:1,taskId:"task",agentKind:"codex",sessionRef:"native",requestId:"real-user-message",
    scopeDigest:"a".repeat(64),revision:1,generation:2,status:"passed",round:1,base:"b".repeat(40),candidateDigest:"c".repeat(64),
    checksPassed:true,blockingFindings:0,limitations:[],findings:[],requiredChecks:["behavior"],checks:[{name:"behavior",method:"node test",result:"passed",evidence:"exit=0;outputSha256=fixture"}],reviewer:{sessionRef:"reviewer",model:"model",provider:"provider",readOnly:true},proof:{checkedAt:now,head:"d".repeat(40),base:"b".repeat(40),candidateDigest:"c".repeat(64),clean:true,valid:true}};
  return{store,db,session,value};
}
it("only the owning native node can record evidence; duplicate revisions are immutable",()=>{
  const f=fixture();expect(()=>recordDevelopmentReviews(f.db,"other",f.session,[f.value],true,"task",1)).toThrow(/reporting native node/);
  expect(()=>recordDevelopmentReviews(f.db,"node",f.session,[{...f.value,sessionRef:"other"}],true,"task",1)).toThrow(/identity mismatch/);
  recordDevelopmentReviews(f.db,"node",f.session,[f.value],true,"task",1);recordDevelopmentReviews(f.db,"node",f.session,[f.value],true,"task",1);
  expect(sessionDevelopmentReviews(f.db,f.session)).toEqual([f.value]);
  expect(()=>recordDevelopmentReviews(f.db,"node",f.session,[{...f.value,status:"incomplete"}],true,"task",1)).toThrow(/different evidence/);
  expect(()=>f.db.connection.exec("UPDATE development_reviews SET revision=99")).toThrow(/immutable/);
  expect(()=>recordDevelopmentReviews(f.db,"node",f.session,[{...f.value,revision:2,generation:1}],true,"task",1)).toThrow(/backwards/);
});
it("legacy sessions remain compatible while opted-in review requires exact fresh clean-head validation",()=>{
  const f=fixture();expect(developmentReviewBlocker(f.db,f.session,"d".repeat(40),f.value.base)).toBeUndefined();
  recordDevelopmentReviews(f.db,"node",f.session,[],true);
  expect(developmentReviewBlocker(f.db,f.session,"d".repeat(40),f.value.base)).toBe("review_missing");
  recordDevelopmentReviews(f.db,"node",f.session,[f.value],true,"task",1);
  expect(developmentReviewBlocker(f.db,f.session,"d".repeat(40),f.value.base)).toBeUndefined();
  expect(developmentReviewBlocker(f.db,f.session,"e".repeat(40),f.value.base)).toBe("review_stale");
  expect(developmentReviewBlocker(f.db,f.session,"d".repeat(40),"e".repeat(40))).toBe("review_stale");
  recordDevelopmentReviews(f.db,"node",f.session,[{...f.value,revision:2,proof:{...f.value.proof!,checkedAt:new Date(Date.now()-600000).toISOString()}}],true,"task",1);
  expect(developmentReviewBlocker(f.db,f.session,"d".repeat(40),f.value.base)).toBe("review_stale");
  recordDevelopmentReviews(f.db,"node",f.session,[{...f.value,revision:3,status:"incomplete",checksPassed:false}],true,"task",1);
  expect(developmentReviewBlocker(f.db,f.session,"d".repeat(40),f.value.base)).toBe("review_incomplete");
  expect(developmentReviewSummary(f.db,f.session)?.records[0]?.status).toBe("incomplete");
});
it("passed-looking text and incomplete or malformed source facts never become evidence",()=>{
  const f=fixture();expect(()=>recordDevelopmentReviews(f.db,"node",f.session,[{...f.value,round:4}],true,"task",1)).toThrow(/Invalid/);
  for (const patch of [{blockingFindings:1},{checksPassed:false},{limitations:["Scope missing"]}]) {
    const previous=sessionDevelopmentReviews(f.db,f.session)[0];
    recordDevelopmentReviews(f.db,"node",f.session,[{...f.value,...patch,revision:(previous?.revision??0)+1}],true,"task",1);
    expect(developmentReviewBlocker(f.db,f.session,"d".repeat(40),f.value.base)).toBe("review_incomplete");
  }
});

it("an explicit follow-up unit has its own gate without erasing previous failures or trusting another repository",()=>{
  const f=fixture();
  recordDevelopmentReviews(f.db,"node",f.session,[{...f.value,status:"cancelled"}],true,"task",1);
  const next={...f.value,taskId:"next",requestId:"next-human-request",repository:"https://github.com/fixture/repo"};
  recordDevelopmentReviews(f.db,"node",f.session,[next],true,"next",2);
  expect(sessionDevelopmentReviews(f.db,f.session)).toHaveLength(2);
  expect(developmentReviewBlocker(f.db,f.session,next.proof!.head,next.base,next.repository)).toBeUndefined();
  expect(developmentReviewBlocker(f.db,f.session,next.proof!.head,next.base,"https://github.com/other/repo")).toBe("review_stale");
  recordDevelopmentReviews(f.db,"node",f.session,[{...next,revision:0,status:"incomplete"}],true,"next",2);
  expect(developmentReviewBlocker(f.db,f.session,next.proof!.head,next.base,next.repository)).toBe("review_incomplete");
  expect(sessionDevelopmentReviews(f.db,f.session).find(r=>r.taskId==="next")?.revision).toBe(1);
});

it("notifies only the owning session when review facts change, without source messages or synthetic input",()=>{
  const f=fixture(), feed=new ConsoleChanges(f.db), cursor=feed.latest();
  try {
    recordDevelopmentReviews(f.db,"node",f.session,[f.value],true,f.value.taskId,1);
    const changes=feed.page(cursor).changes;
    expect(changes.some(c=>c.kind==="sessions" && c.account_id==="owner" && c.resource_id===f.session)).toBe(true);
    const after=feed.latest();recordDevelopmentReviews(f.db,"node",f.session,[f.value],true,f.value.taskId,1);
    expect(feed.page(after).changes).toEqual([]);
    expect(f.db.connection.prepare("SELECT COUNT(*) AS n FROM agent_session_messages WHERE session_id=?").get(f.session)).toMatchObject({n:0});
  } finally {feed.close();}
});

it("late snapshots cannot roll the active task back or reuse its ledger revision",()=>{
  const f=fixture();recordDevelopmentReviews(f.db,"node",f.session,[f.value],true,"task",1);
  const current={...f.value,taskId:"next",requestId:"next-human",status:"developing",proof:undefined};
  recordDevelopmentReviews(f.db,"node",f.session,[current],true,"next",2);
  recordDevelopmentReviews(f.db,"node",f.session,[f.value],true,"task",1);
  expect(developmentReviewSummary(f.db,f.session)?.activeTaskId).toBe("next");
  expect(developmentReviewBlocker(f.db,f.session,f.value.proof!.head,f.value.base)).toBe("review_incomplete");
  expect(()=>recordDevelopmentReviews(f.db,"node",f.session,[f.value],true,"task",2)).toThrow(/another active task/);
});

it("missing ledger metadata cannot clear an established review requirement",()=>{
  const f=fixture();recordDevelopmentReviews(f.db,"node",f.session,[f.value],true,"task",1);
  expect(developmentReviewBlocker(f.db,f.session,f.value.proof!.head,f.value.base)).toBeUndefined();
  recordDevelopmentReviews(f.db,"node",f.session,[],true);
  expect(developmentReviewBlocker(f.db,f.session,f.value.proof!.head,f.value.base)).toBe("review_incomplete");
  recordDevelopmentReviews(f.db,"node",f.session,[f.value],true,"task",1);
  recordDevelopmentReviews(f.db,"node",f.session,undefined);
  expect(developmentReviewBlocker(f.db,f.session,f.value.proof!.head,f.value.base)).toBe("review_incomplete");
});

it("a missing historical local record does not override a valid current unit",()=>{
  const f=fixture();recordDevelopmentReviews(f.db,"node",f.session,[f.value],true,"task",1);
  const current={...f.value,taskId:"next",requestId:"next-human"};
  recordDevelopmentReviews(f.db,"node",f.session,[{...f.value,revision:0,status:"incomplete"},current],true,"next",2);
  expect(developmentReviewBlocker(f.db,f.session,f.value.proof!.head,f.value.base)).toBeUndefined();
});
