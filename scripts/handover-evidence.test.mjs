import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {publicReleaseEvidence,saveReleaseEvidence} from "./handover-evidence.mjs";

test("persists only independently verified public facts outside the tracked checkout",()=>{
 const repo=mkdtempSync(join(tmpdir(),"missiongo-handover-"));
 try {
  execFileSync("git",["init","--quiet",repo]);
  const receipt={current:{web:{version:"abc",commit:"a".repeat(40),clean:true,ciPassed:true},macosApp:{version:"1.0",sourceCommit:"b".repeat(40),sha256:"c".repeat(64)}},publicEvidence:{checks:{web:true,macosApp:false}}};
  const evidence=publicReleaseEvidence(receipt,"https://release.example.test");
  assert.equal(evidence.releases.length,1);assert.equal(evidence.releases[0].proof.kind,"health");
  assert.equal(saveReleaseEvidence(evidence,repo),1);
  assert.deepEqual(JSON.parse(readFileSync(join(repo,".git/missiongo-release-evidence.json"),"utf8")),evidence);
  assert.equal(execFileSync("git",["-C",repo,"status","--porcelain"],{encoding:"utf8"}),"");
 } finally {rmSync(repo,{recursive:true,force:true});}
});
test("refuses credentials, insecure URLs, duplicate artifacts and malformed hashes",()=>{
 assert.throws(()=>publicReleaseEvidence({},"http://release.example.test"));
 assert.throws(()=>publicReleaseEvidence({},"https://user:password@release.example.test"));
 const release={artifact:"web",version:"1.0",sourceCommit:"a".repeat(40),proof:{kind:"sha256",url:"https://release.example.test/file",sha256:"bad"}};
 assert.throws(()=>saveReleaseEvidence({schemaVersion:1,releases:[release]}));
});
