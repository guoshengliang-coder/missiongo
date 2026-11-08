import { describe,expect,it } from "vitest";
import { localChangeEvidenceSchema, evidenceDigest } from "./non-release-evidence.js";
const validation={checks:[{name:"check",method:"compare",result:"passed",evidence:"digest matched"}],remainingVerification:[],limitations:[]};
const file={name:"tool.mjs",beforeSha256:"a".repeat(64),afterSha256:"b".repeat(64),sizeBytes:10};
const input={version:1,target:"node test",summary:"change tool",files:[file],rollback:"restore backup",validation};
describe("bounded local change evidence",()=>{
 it("canonicalizes resource ordering and fields before computing a digest",()=>{
  const a=localChangeEvidenceSchema.parse({...input,files:[file,{...file,name:"another.mjs"}]});
  const b=localChangeEvidenceSchema.parse({...input,files:[{...file,name:"another.mjs"},file]});
  expect(evidenceDigest(a)).toBe(evidenceDigest(b));
 });
 it.each(["/private/secret","../escape","a/../escape","a\\b","C:/secret","a//b","~/secret","a/./b"])("rejects unsafe resource %s",name=>{
  expect(localChangeEvidenceSchema.safeParse({...input,files:[{...file,name}]}).success).toBe(false);
 });
 it("requires actual before/after changes, unique bounded files, rollback and validation",()=>{
  for(const patch of [{files:[]},{files:[file,file]},{files:Array.from({length:33},(_,i)=>({...file,name:`f${i}`}))},
   {files:[{...file,afterSha256:file.beforeSha256}]},{files:[{...file,beforeSha256:null,afterSha256:null}]},
   {rollback:""},{validation:{...validation,checks:[]}}, {files:[{...file,afterSha256:null,sizeBytes:1}]}])
    expect(localChangeEvidenceSchema.safeParse({...input,...patch}).success).toBe(false);
 });
});
