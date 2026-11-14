#!/usr/bin/env node
// Investigation only. This report is never a deploy/check receipt or authorization.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE_TOOL_FILES, RELEASE_CAPABILITY_CHECKS } from "./release-tool-files.mjs";
import { releaseCandidatesFromPages, releaseSelectionDigest, candidateIdentity } from "./release-candidates.mjs";
import { coverageForCheckout, integrationFacts, commitContains, COVERAGE_ARTIFACTS } from "./release-coverage.mjs";
import { checkArtifacts, planVersionGaps } from "./release-preflight.mjs";
import { readSnapshot } from "./release-receipt.mjs";
import { repositoryIdentity } from "./handover-evidence.mjs";

const sha = value => /^[a-f0-9]{40}$/.test(value ?? "");
const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const json = path => JSON.parse(readFileSync(path, "utf8"));
const regular = path => existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink();

/** Fixed inventory only, no manifest-controlled paths and no writes, even for old installations. */
export function inspectInstalledTools(root, { home = homedir(), configHome = process.env.XDG_CONFIG_HOME ?? join(home, ".config") } = {}) {
  if (!configHome.startsWith("/")) throw new Error("Configuration root must be absolute");
  const config = join(configHome, "missiongo"), manifestPath = join(config, "release-tools-manifest.json");
  let manifest = null, manifestError = null;
  try { manifest = regular(manifestPath) ? json(manifestPath) : null; }
  catch { manifestError = "unreadable_manifest"; }
  const installedTexts=new Map();
  const files = Object.entries(RELEASE_TOOL_FILES).map(([name, source]) => {
    const target = name === "entry" ? join(home, ".local/bin/missiongo-release") : join(config, "release-tools", name);
    const original = join(root, "scripts", source);
    const installedBytes=regular(target)?readFileSync(target):null;
    if(installedBytes)installedTexts.set(name,installedBytes.toString("utf8"));
    const installedSha256 = installedBytes ? hash(installedBytes) : null;
    const sourceSha256 = regular(original) ? hash(readFileSync(original)) : null;
    const recordedSha256 = manifest?.tools?.[name] ?? null;
    return { name, installedSha256, sourceSha256, recordedSha256,
      status: !installedSha256 ? "missing_or_unsafe" : !sourceSha256 ? "source_missing" : installedSha256 !== recordedSha256 ? "manifest_mismatch" : installedSha256 !== sourceSha256 ? "source_differs" : "matching" };
  });
  // Follow actual fixed local import/call edges, never inventory or capability
  // table names. An omitted manifest entry cannot hide a missing runtime import.
  const missing=new Set(),visited=new Set(),pending=Object.keys(RELEASE_CAPABILITY_CHECKS);
  while(pending.length) {
    const name=pending.pop();if(visited.has(name))continue;visited.add(name);
    const source=installedTexts.get(name);
    if(source===undefined){missing.add(name);continue;}
    if((RELEASE_CAPABILITY_CHECKS[name]??[]).some(pattern=>!pattern.test(source)))missing.add(name);
    const dependencies=[
      ...[...source.matchAll(/^\s*import\s+(?:[^;\n]*?\s+from\s+)?["']\.\/([^"']+)["']/gm)].map(m=>m[1]),
      ...[...source.matchAll(/^\s*from (release[_a-z]+) import /gm)].map(m=>`${m[1]}.py`),
      ...[...source.matchAll(/TOOLS \/ ["']([a-zA-Z0-9_.-]+\.(?:mjs|py|sh))["']/g)].map(m=>m[1]),
      ...[...source.matchAll(/^\s*(?:source|node) ["']\$(?:\{MISSIONGO_RELEASE_TOOLS\}|coverage_tools)\/([a-zA-Z0-9_.-]+)["']/gm)].map(m=>m[1]),
    ];
    for(const dependency of dependencies) {
      if(Object.hasOwn(RELEASE_TOOL_FILES,dependency))pending.push(dependency);
      else missing.add("unsupported_local_dependency");
    }
  }
  const missingCapabilities=[...missing].sort();
  return { sourceCommit: manifest?.sourceCommit ?? null, files, manifestError,
    integrity: manifestError || !manifest ? "unverified" : files.some(f => f.status === "manifest_mismatch"
      || f.status === "missing_or_unsafe" && Object.hasOwn(manifest.tools ?? {}, f.name)) ? "damaged" : "verified",
    capabilities: { missing: missingCapabilities, status: missingCapabilities.length ? "missing" : "verified" },
    status: files.every(file => file.status === "matching") ? "matching" : "review_required",
    nextOwner: "本机工具维护者", nextAction: "核实差异及兼容性；获安装授权后用版本化安装器升级，不自动覆盖" };
}

/** Classifications are observations, never an approval or a deploy receipt. */
export function classifyReadiness(checks, historicalGaps, batch) {
  const releaseArtifacts = new Set([...(batch.publicationScope?.requiredArtifacts ?? []), ...batch.entries.flatMap(e => e.requiredArtifacts)]);
  const publicationRequired = releaseArtifacts.size > 0;
  return checks.flatMap(check => {
    const base = { id: check.name, reason: check.reason ?? "核对原始检查结果", owner: check.nextOwner,
      resumeWhen: "核实所需事实并在原批次刷新受影响证据", state: check.status === "unverified" ? "unknown" : "satisfied" };
    if (check.name === "tools") {
      const tools = check.value;
      return [
        {...base,id:"installation_integrity",kind:"installation_integrity",category:tools?.integrity==="verified"?"fact":"blocker",stage:"pre_merge",required:publicationRequired,
          state:tools?.integrity==="verified"?"satisfied":tools?.integrity==="damaged"?"pending":"unknown",dependencies:["tools"],reason:"核对正式工具磁盘摘要与可信安装清单"},
        {...base,id:"required_capability",kind:"required_capability",category:tools?.capabilities?.status==="verified"?"fact":"blocker",stage:"pre_merge",required:publicationRequired,
          state:tools?.capabilities?.status==="verified"?"satisfied":"unknown",dependencies:["tools","capabilities"],reason:"核对本次发布必需的锁、CI 与完整范围能力"},
        {...base,id:"tool_difference",kind:"tool_difference",category:"notice",stage:"pre_merge",required:false,dependencies:["tools"],
          state:tools?.status==="matching"?"satisfied":"pending",reason:"普通源码差异只提示；不能从差异推断安装授权必要性"},
      ];
    }
    const main = ["main","checkout_consistency"].includes(check.name);
    const prospective = check.name.startsWith("prospective:");
    const post = ["versions","patch_bumps"].includes(check.name) || check.name.startsWith("release_notes:");
    const artifact = check.name.startsWith("artifact:") ? check.name.slice(9) : undefined;
    const needed = publicationRequired && (main || prospective || !post && (!artifact || releaseArtifacts.has(artifact)));
    return [{...base,kind:check.name==="main"?"main":post?"version":artifact?"artifact":"investigation",
      category:post?"work":"fact",stage:main||prospective?"pre_merge":post?"post_merge":"pre_publish",required:needed,
      dependencies:main||prospective?["base","heads"]:["candidates"],
      state:post && (check.value?.length || check.value?.missing?.length)?"pending":base.state}];
  }).concat(historicalGaps.map((gap,index)=>({id:`historical:${index}`,kind:"investigation",category:"fact",stage:"pre_publish",required:publicationRequired,
    state:"unknown",reason:`${gap.identity}: ${gap.missing.join(", ")}`,owner:gap.nextOwner,resumeWhen:gap.nextAction,dependencies:["candidates"]})));
}

/** Pure collection seam: independent failures survive in a single bounded report. */
export function collectReadiness({ config, candidates, batch, now = Date.now() }, operations) {
  const snapshot = releaseCandidatesFromPages(candidates, { coverage: true, now });
  const repository = operations.repository(), head = operations.head(), originMain = operations.originMain();
  if (config?.schemaVersion !== 1 || snapshot.productId !== config.productId || repository.toLowerCase() !== config.repository?.toLowerCase()) throw new Error("Readiness product/repository binding differs");
  if (!sha(head) || !sha(originMain)) throw new Error("Readiness requires exact HEAD and origin/main");
  if (!batch || batch.productId !== snapshot.productId || typeof batch.id !== "string" || typeof batch.publish!=="boolean" || !Array.isArray(batch.deliveries) || batch.deliveries.length === 0 || !Array.isArray(batch.entries)
    || !Array.isArray(batch.selection) || batch.selection.length !== batch.deliveries.length || new Set(batch.selection.map(s=>s.id)).size !== batch.deliveries.length
    || batch.selection.some(s=>!batch.deliveries.includes(s.id)||typeof s.revision!=="string"||!s.revision.trim())
    || new Set(batch.deliveries).size !== batch.deliveries.length || batch.entries.length !== batch.deliveries.length
    || new Set(batch.entries.map(entry => entry.id)).size !== batch.entries.length
    || batch.entries.some(entry => !Number.isSafeInteger(entry.pullRequest) || entry.pullRequest <= 0 || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/.test(entry.targetBranch ?? "") || !batch.deliveries.includes(entry.id) || entry.repository?.toLowerCase() !== repository.toLowerCase() || !sha(entry.executionHead ?? entry.head) || !Array.isArray(entry.requiredArtifacts) || new Set(entry.requiredArtifacts).size !== entry.requiredArtifacts.length || !entry.requiredArtifacts.length && (typeof entry.noReleaseReason !== "string" || !entry.noReleaseReason.trim()) || entry.requiredArtifacts.some(a => !COVERAGE_ARTIFACTS.includes(a)))) {
    throw new Error("Use the complete get_merge_batch batch, with exact product, repository and frozen/execution heads");
  }
  const checks = [];
  const collect = (name, nextOwner, operation) => {
    try { const value = operation(); checks.push({ name, status: "observed", value, nextOwner }); return value; }
    catch (error) { checks.push({ name, status: "unverified", reason: error.message, nextOwner }); return undefined; }
  };
  collect("main", "集成执行者", () => {
    const remote = operations.remoteMain();
    if (remote !== originMain) throw new Error("origin/main is stale; fetch and repeat investigation");
    if (!operations.ancestor(originMain, head)) throw new Error("Checkout does not contain latest main; rebase or merge before integration");
    return { remoteMain: remote, headContainsMain: true };
  });
  collect("tools", "本机工具维护者", () => operations.tools());
  const live = collect("live_snapshot", "发布执行者", () => operations.live());
  const artifacts = [];
  for (const artifact of COVERAGE_ARTIFACTS.filter(name => name !== "web")) {
    const records = collect(`artifact:${artifact}`, "发布执行者", () => operations.artifact(artifact, live));
    if (records) artifacts.push(...records);
  }
  collect("coverage", "集成执行者", () => operations.coverage(artifacts, live));
  collect("versions", "集成执行者", () => operations.versions(live));
  collect("patch_bumps", "集成执行者", () => operations.patchBumps());
  for (const artifact of ["androidApp", "macosApp"]) collect(`release_notes:${artifact}`, "集成执行者", () => operations.notes(artifact));
  for (const entry of batch.entries) collect(`prospective:${entry.id}`, "集成执行者", () => operations.prospective(entry));
  collect("checkout_consistency", "集成执行者", () => {
    if (operations.head() !== head || operations.originMain() !== originMain || operations.remoteMain() !== originMain) throw new Error("Main or checkout changed during investigation; refresh all evidence");
    return { head, originMain };
  });
  const historicalGaps = snapshot.candidates.flatMap(candidate => {
    const missing = [...(!candidate.completion && !candidate.pullRequestUrl ? ["integration"] : []), ...(!Array.isArray(candidate.requiredArtifacts) || !candidate.requiredArtifacts.length ? ["release_scope"] : [])];
    return missing.length ? [{ identity: candidateIdentity(candidate), missing, nextOwner: "产品操作者与集成执行者", nextAction: "先核实证据；需范围取舍时由用户决定，不自动补写或排除" }] : [];
  });
  const needsFollowUp = historicalGaps.length > 0 || checks.some(check => check.status === "unverified"
    || check.name === "tools" && check.value?.status !== "matching" || check.name === "coverage" && check.value?.ready !== true
    || check.name === "versions" && check.value?.length > 0 || check.name === "patch_bumps" && check.value?.length > 0
    || check.name.startsWith("release_notes:") && check.value?.missing?.length > 0);
  const conditions=classifyReadiness(checks,historicalGaps,batch);
  return { schemaVersion: 1, kind: "integration_readiness", needsFollowUp: needsFollowUp || conditions.some(c=>c.state==="pending"||c.state==="unknown"), checkedAt: new Date(now).toISOString(), productId: snapshot.productId, repository,
    head, originMain, batchId: batch.id, batchRevision: batch.integration?.revision ?? null,
    batchDigest: hash(batch), candidatesDigest: releaseSelectionDigest(snapshot), snapshotAt: snapshot.snapshotAt,
    candidates: snapshot.candidates.map(candidate => ({ identity: candidateIdentity(candidate), requiredArtifacts: candidate.requiredArtifacts ?? null })),
    noReleaseItems: snapshot.noReleaseItems, noReleaseDeliveries: snapshot.noReleaseDeliveries, historicalGaps, checks,
    conditions,
    observation: {batchId:batch.id,heads:batch.deliveries.map(id=>{const e=batch.entries.find(e=>e.id===id);return {deliveryId:id,head:e.executionHead??e.head};}),
      scope:hash([batch.selection,batch.operation??null,batch.publish,batch.publicationScope?.digest??null])},
    evidenceContext: { base: originMain, candidates: releaseSelectionDigest(snapshot),
      tools: hash(checks.find(c=>c.name==="tools")?.value?.files?.filter(f=>f.installedSha256||f.recordedSha256).map(f=>[f.name,f.installedSha256,f.recordedSha256]) ?? null),
      capabilities: hash(checks.find(c=>c.name==="tools")?.value?.capabilities ?? null) },
    prerequisiteBoundary: "分类结果不是首合并许可。原执行者还须核实当前发布范围及原生授权是否必需/有效，在原批次登记 main、installation_integrity、required_capability、authorization、scope；不由 needsFollowUp 或退出码推断许可。",
    decisions: [], // Never invent a human scope choice from a technical failure.
    boundary: "调查快照，不证明已就绪、已安装、已发布或已验收；主线、head、批次或候选变化后重新核查，部署前仍运行实时完整门禁" };
}

export async function readinessForCheckout({ root, config, candidates, batch, settings, home, configHome }) {
  const ledger = json(join(root, "released.json"));
  const modules = await Promise.allSettled(["release-state.mjs", "release-notes.mjs", "web-version.mjs"].map(file => import(pathToFileURL(join(root, "scripts", file)).href)));
  const module = index => { const result = modules[index]; if (result.status === "rejected") throw new Error("Checkout lacks usable " + ["release-state", "release-notes", "web-version"][index] + " support"); return result.value; };
  return collectReadiness({ root, config, candidates, batch }, {
    repository: () => repositoryIdentity(git(root, "config", "--get", "remote.origin.url")),
    head: () => git(root, "rev-parse", "HEAD"), originMain: () => git(root, "rev-parse", "origin/main"),
    remoteMain: () => git(root, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0],
    ancestor: (older, newer) => commitContains(root, older, newer), tools: () => inspectInstalledTools(root, { home, configHome }),
    live: () => readSnapshot(settings),
    artifact: (artifact, live) => checkArtifacts(root, live, { onlyArtifacts: [artifact] }),
    coverage: (artifacts, live) => coverageForCheckout({ root, config, candidates, artifacts: [{ artifact: "web", version: json(join(root, "product.json")).web.version, sourceCommit: git(root, "rev-parse", "HEAD") }, ...artifacts], live, planning: true }),
    versions: live => planVersionGaps(root, live), patchBumps: () => module(0).planPatchVersions("origin/main", root),
    notes: artifact => ({ artifact,
      missing: module(1).undeclaredClientPullRequests({ root, from: ledger.artifacts[artifact].commit, to: "HEAD", client: module(1).CLIENTS[artifact] }) }),
    prospective: entry => {
      const head = entry.executionHead ?? entry.head;
      const url = `${entry.repository}/pull/${entry.pullRequest}`;
      const facts = integrationFacts({ completion: { kind: "github", url } }, config.repository, root);
      const current = JSON.parse(execFileSync("gh", ["pr", "view", url, "--json", "headRefOid,baseRefName"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }));
      if (current.headRefOid !== head || current.baseRefName !== entry.targetBranch) throw new Error("PR head/target changed; refresh the original batch before projecting impact");
      const files = git(root, "diff", "--name-only", "origin/main..." + head).split("\n").filter(Boolean);
      const artifacts = Object.entries(ledger.artifacts).filter(([, value]) => files.some(file => value.paths.some(path => file === path || file.startsWith(path.replace(/\/$/, "") + "/")))).map(([name]) => name);
      const webPaths = [...module(2).WEB_RELEASE_PATHS, "services"];
      if (files.some(file => webPaths.some(path => file === path || file.startsWith(path.replace(/\/$/, "") + "/")))) artifacts.unshift("web");
      return { deliveryId: entry.id, head, integration: facts, expectedArtifacts: [...new Set([...artifacts, ...entry.requiredArtifacts])],
        declaredArtifacts: entry.requiredArtifacts, noReleaseReason: entry.noReleaseReason ?? null, prospective: true,
        nextAction: "预计影响；核实原PR完整说明，实际合并后重查release:state，统一patch与发布说明，不提前写账本" };
    },
  });
}

export function parseReadOnlyArgs(args, flags) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!flags.includes(args[i]) || values[args[i]] !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Unknown, repeated or missing read-only option");
    values[args[i]] = args[i + 1];
  }
  return values;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = parseReadOnlyArgs(process.argv.slice(2), ["--root", "--candidates", "--batch"]);
    if (!args["--candidates"] || !args["--batch"]) throw new Error("Use readiness --candidates <complete pages> --batch <get_merge_batch JSON>");
    const root = resolve(args["--root"] ?? process.cwd()), configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), config = join(configHome, "missiongo");
    const settings = json(join(config, "release-local.json"));
    const raw = json(args["--batch"]);
    const report = await readinessForCheckout({ root, config: json(join(config, "release-coverage.json")), candidates: json(args["--candidates"]), batch: raw.batch ?? raw,
      settings: { host: settings.host, currentLink: settings.currentLink, downloadsDir: settings.downloadsDir } });
    console.log(JSON.stringify(report, null, 2));
    if (report.needsFollowUp) process.exitCode = 1;
  } catch (error) { console.error(`Readiness failed: ${error.message}`); process.exitCode = 1; }
}
