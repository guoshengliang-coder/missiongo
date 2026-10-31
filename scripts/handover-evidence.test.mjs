import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync,readdirSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {publicReleaseEvidence,saveReleaseEvidence,repositoryIdentity} from "./handover-evidence.mjs";

test("persists only independently verified public facts outside the tracked checkout",()=>{
 const repo=mkdtempSync(join(tmpdir(),"missiongo-handover-"));
 try {
  execFileSync("git",["init","--quiet",repo]);
  execFileSync("git",["-C",repo,"remote","add","origin","git@git.example.test:team/project.git"]);
  const receipt={current:{web:{version:"abc",commit:"a".repeat(40),clean:true,ciPassed:true},macosApp:{version:"1.0",sourceCommit:"b".repeat(40),sha256:"c".repeat(64)}},publicEvidence:{checks:{web:true,macosApp:false}}};
  const evidence=publicReleaseEvidence(receipt,"https://release.example.test");
  assert.equal(evidence.releases.length,1);assert.equal(evidence.releases[0].proof.kind,"health");
  assert.equal(saveReleaseEvidence(evidence,repo),1);
  assert.deepEqual(JSON.parse(readFileSync(join(repo,".git/missiongo-release-evidence.json"),"utf8")),evidence);
  const outbox=join(repo,".git/missiongo-release-outbox");
  const queued=JSON.parse(readFileSync(join(outbox,readdirSync(outbox)[0]),"utf8"));
  assert.equal(queued.schemaVersion,2);
  assert.equal(queued.repository,"https://git.example.test/team/project");
  assert.equal(queued.environment,"production");
  assert.deepEqual(queued.releases,evidence.releases);
  assert.equal(statSync(join(outbox,readdirSync(outbox)[0])).mode & 0o777,0o600);
  saveReleaseEvidence({...evidence,environment:"staging"},repo);
  assert.equal(readdirSync(outbox).length,2);
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

test("repository identity supports hosted and self-hosted GitHub/GitLab without transmitting SSH credentials",()=>{
 assert.equal(repositoryIdentity("ssh://git@git.example.test:2222/team/sub/project.git"),"https://git.example.test/team/sub/project");
 assert.equal(repositoryIdentity("https://github.com/example/project.git"),"https://github.com/example/project");
 assert.throws(()=>repositoryIdentity("https://secret@github.com/example/project.git"));
 assert.throws(()=>repositoryIdentity("https://github.com/example/project.git?token=secret"));
});
