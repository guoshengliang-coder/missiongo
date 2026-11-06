#!/usr/bin/env node
// Read-only proof for reserved repairs. Git credentials stay on the executor.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const sha=/^[a-f0-9]{40}$/;
export function inspectRepair(input,run=(command,args)=>execFileSync(command,args,{encoding:"utf8",timeout:30_000}).trim()) {
  const {repository,pullRequest,targetBranch,fromHead,head,commits,base}=input;
  if(!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repository)||!Number.isSafeInteger(pullRequest)||pullRequest<1||
    !/^[\w][\w./-]{0,150}$/.test(targetBranch)||![fromHead,head,base].every(v=>sha.test(v))||head===fromHead||
    !Array.isArray(commits)||!commits.length||commits.length>100||!commits.every(v=>sha.test(v)))throw new Error("Invalid reserved repair");
  const repo=repository.slice("https://github.com/".length);
  const local=JSON.parse(run("gh",["repo","view","--json","nameWithOwner"]));
  if(local.nameWithOwner?.toLowerCase()!==repo.toLowerCase())throw new Error("Wrong execution repository");
  const pr=JSON.parse(run("gh",["pr","view",String(pullRequest),"--repo",repo,"--json","url,state,headRefOid,baseRefName"]));
  if(pr.url!==`${repository}/pull/${pullRequest}`||pr.state!=="OPEN"||pr.headRefOid!==head||pr.baseRefName!==targetBranch)throw new Error("Remote PR changed; never absorb external commits");
  run("git",["merge-base","--is-ancestor",fromHead,head]);
  // Mainline commits used to resolve conflicts are allowed; other added commits must
  // exactly match the executor's recorded repair commits, not a guessed author name.
  const actual=run("git",["rev-list","--reverse","--topo-order",head,`^${fromHead}`,`^${base}`]).split("\n").filter(Boolean);
  if(JSON.stringify(actual)!==JSON.stringify(commits)||actual.at(-1)!==head)throw new Error("Repair chain contains unrecorded or external commits");
  return {fromHead,head,base,commits:actual,source:pr.url};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(inspectRepair(JSON.parse(readFileSync(process.argv[2],"utf8")))));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
