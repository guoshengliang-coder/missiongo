import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localDevelopmentReviewRequired, localDevelopmentReviews, localDevelopmentReviewSnapshot } from "./development-reviews.js";
it("reads only the exact native index, reports known missing records, and never treats a model claim as a passed test",async()=>{
  const root=await mkdtemp(join(tmpdir(),"review-node-"));
  const key=createHash("sha256").update("codex:native").digest("hex");
  const save=(name:string,value:unknown)=>writeFile(join(root,name+".json"),JSON.stringify(value),{mode:0o600});
  try {
    await save("policy-"+key,{version:1,agentKind:"codex",sessionRef:"native",required:true});
    expect(await localDevelopmentReviewRequired("codex","native",root)).toBe(true);
    expect(await localDevelopmentReviewRequired("codex","other",root)).toBe(false);
    await save("session-"+key,{version:1,revision:2,taskIds:["task"],activeTaskId:"task"});
    expect((await localDevelopmentReviews("codex","native",root))?.[0]?.status).toBe("incomplete");
    await save("task",{version:1,taskId:"task",revision:4,generation:2,status:"passed",binding:{agentKind:"codex",sessionRef:"native",requestId:"human",scopeDigest:"a".repeat(64),base:"b".repeat(40),requiredChecks:["behavior"]},rounds:[{result:{findings:[],limitations:[]}}],checks:[]});
    const evidence=(await localDevelopmentReviews("codex","native",root))?.[0];
    expect(evidence?.status).toBe("passed");expect(evidence?.checksPassed).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain(root);
    expect(await localDevelopmentReviews("codex","unrelated",root)).toBeUndefined();
    expect(await localDevelopmentReviewSnapshot("codex","native",root)).toMatchObject({taskId:"task",revision:2});
  } finally {await rm(root,{recursive:true,force:true});}
});

it("syncs a command fingerprint without uploading private validation arguments",async()=>{
  const root=await mkdtemp(join(tmpdir(),"review-private-"));
  const key=createHash("sha256").update("codex:native").digest("hex"), secret="SYNTHETIC_PRIVATE_ARGUMENT";
  const method=JSON.stringify(["node","test.mjs","--token",secret]);
  try {
    await writeFile(join(root,"session-"+key+".json"),JSON.stringify(["task"]),{mode:0o600});
    await writeFile(join(root,"task.json"),JSON.stringify({version:1,taskId:"task",revision:1,generation:1,status:"validating",binding:{agentKind:"codex",sessionRef:"native",requestId:"human",scopeDigest:"a".repeat(64),base:"b".repeat(40),requiredChecks:["test"]},rounds:[],checks:[{name:"test",method,result:"passed",evidence:"exit=0"}]}),{mode:0o600});
    const evidence=await localDevelopmentReviews("codex","native",root);
    expect(JSON.stringify(evidence)).not.toContain(secret);
    expect(evidence?.[0]?.checks?.[0]?.method).toBe("local validation; argvSha256="+createHash("sha256").update(method).digest("hex"));
  } finally {await rm(root,{recursive:true,force:true});}
});
