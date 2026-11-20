import {readFileSync,writeFileSync} from "node:fs";
import {isDeepStrictEqual} from "node:util";
import {releaseCandidatesFromPages} from "./release-candidates.mjs";
import {fileURLToPath} from "node:url";
import {readSnapshot,verifyPublic,buildReceipt} from "./release-receipt.mjs";
import {coverageForCheckout,receiptArtifacts,assertReleaseCoverage,releaseScope} from "./release-coverage.mjs";
import {publicReleaseEvidence,saveReleaseEvidence} from "./handover-evidence.mjs";

/** No deployment mutation or execution replay; retain both the failed and fresh evidence. */
export async function verifyExistingRelease(before,options,dependencies={readSnapshot,verifyPublic}) {
  if(before?.schemaVersion!==1||!/^[a-f0-9]{40}$/.test(before.deployedCommit??"")||before.current?.web?.commit!==before.deployedCommit||!before.previous)
    throw new Error("Use the complete original deployment receipt");
  const current=dependencies.readSnapshot(options);
  if(current.web?.commit!==before.deployedCommit||!current.web.clean||!current.web.ciPassed)
    throw new Error("The actual deployment changed; reconcile its exact head before verification");
  if(!isDeepStrictEqual(current,before.current))throw new Error("The actual artifact snapshot changed; reconcile it before verification");
  const evidence=await dependencies.verifyPublic(options.origin,current);
  const after=dependencies.readSnapshot(options);
  if(!isDeepStrictEqual(after,current))throw new Error("Deployment or artifacts changed during verification");
  return buildReceipt(before.previous,current,evidence);
}
export function verificationScopeOptions(values) {
  const onlyArtifacts=values.get("--only-artifacts"),scopeReason=values.get("--scope-reason");
  releaseScope(onlyArtifacts,scopeReason);
  return onlyArtifacts===undefined?{}:{onlyArtifacts,scopeReason};
}
async function main(args) {
  const allowed=new Set(["--root","--host","--current-link","--downloads-dir","--origin","--coverage-config","--receipt","--candidates","--selection","--selection-digest","--only-artifacts","--scope-reason","--output"]);
  if(args.length%2)throw new Error("Use named verification arguments");
  const values=new Map();for(let i=0;i<args.length;i+=2){if(!allowed.has(args[i])||values.has(args[i]))throw new Error("Unknown or duplicate verification argument");values.set(args[i],args[i+1]);}
  const get=k=>{const v=values.get(k);if(!v)throw new Error(`Missing ${k}`);return v;};
  const json=k=>JSON.parse(readFileSync(get(k),"utf8"));
  const origin=new URL(get("--origin"));if(origin.protocol!=="https:"||origin.username||origin.password||origin.pathname!=="/"||origin.search||origin.hash)throw new Error("Use the configured HTTPS origin");
  const scopeOptions=verificationScopeOptions(values);
  releaseCandidatesFromPages(json("--candidates"),{coverage:true});
  const receipt=await verifyExistingRelease(json("--receipt"),{host:get("--host"),currentLink:get("--current-link"),downloadsDir:get("--downloads-dir"),origin:origin.href});
  // Always retain a genuine failed recheck; success still requires complete coverage.
  writeFileSync(get("--output"),JSON.stringify(receipt)+"\n",{flag:"wx",mode:0o600});
  if(receipt.publicEvidence.checks.web!==true)throw new Error("Public Web identity is not verified; retain the failed receipt");
  const plan=coverageForCheckout({...scopeOptions,root:get("--root"),config:json("--coverage-config"),candidates:json("--candidates"),receipt,artifacts:receiptArtifacts(receipt),
    ...(values.has("--selection")?{selection:json("--selection"),selectionDigest:get("--selection-digest")}: {})});
  assertReleaseCoverage(plan);
  saveReleaseEvidence(publicReleaseEvidence(receipt,origin.href),get("--root"));
  console.log(JSON.stringify({verified:true,scope:"selected-required-artifacts",receiptDigest:plan.receiptDigest,coverage:plan}));
}
if(process.argv[1]===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
