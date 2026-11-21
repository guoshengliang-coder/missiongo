// Read-only adapter. projectRules is an executor's reading of existing rules, not a required config file.
export function collectProjectVerification(delivery, pr, run) {
  const rules = delivery.projectRules;
  if (!rules) return undefined; // Legacy clients retain unknown for absent CI.
  if (!rules.source?.trim() || !/^[a-f0-9]{64}$/.test(rules.digest ?? "") || !rules.reason?.trim()
    || !["required", "not_required"].includes(rules.ci) || !["required", "not_required"].includes(rules.local))
    throw new Error("Read existing project rules with a source, digest and applicability reason");
  const repo = delivery.repository.slice("https://github.com/".length), branch = encodeURIComponent(delivery.targetBranch);
  const read = path => JSON.parse(run("gh", ["api", `repos/${repo}${path ? `/${path}` : ""}`]));
  // Read-only Contents/Metadata endpoints suffice; do not require Administration permission.
  // Failed reads still never prove absence of CI.
  const metadata = read("");
  const target = read(`branches/${branch}`);
  const activeRules = read(`rules/branches/${branch}`);
  if (target.name !== delivery.targetBranch || typeof target.protected !== "boolean" || !Array.isArray(activeRules)) throw new Error("Incomplete platform policy evidence");
  const protection = target.protection ?? (target.protected ? undefined : {});
  if (!protection) throw new Error("Incomplete branch protection summary");
  if (!Array.isArray(pr.statusCheckRollup) || activeRules.some(r=>r.type === "required_status_checks" && !Array.isArray(r.parameters?.required_status_checks)))
    throw new Error("Incomplete check or ruleset evidence");
  const protectedNames = [...new Set([
    ...(protection.required_status_checks?.contexts ?? []),
    ...(protection.required_status_checks?.checks ?? []).map(c => c.context),
    ...activeRules.filter(r => r.type === "required_status_checks").flatMap(r => (r.parameters?.required_status_checks ?? []).map(c => c.context)),
  ])];
  if (rules.requiredChecks !== undefined && !Array.isArray(rules.requiredChecks)) throw new Error("Invalid project check list");
  const requiredChecks = [...new Set([...protectedNames,...(rules.requiredChecks ?? [])])];
  if (!requiredChecks.every(v => typeof v === "string" && v.trim()) || requiredChecks.length > 200)
    throw new Error("Invalid required check evidence");
  // A required workflow rule cannot be interpreted as an empty set of required status checks.
  const requiredWorkflow = activeRules.some(r => r.type === "workflows");
  const observedChecks = (pr.statusCheckRollup ?? []).map(c => c.name ?? c.context);
  if (!observedChecks.every(v => typeof v === "string" && v.trim()) || observedChecks.length > 200)
    throw new Error("Incomplete named check evidence");
  const queue = activeRules.some(r => r.type === "merge_queue");
  const allowed = {merge: metadata.allow_merge_commit, squash: metadata.allow_squash_merge, rebase: metadata.allow_rebase_merge};
  const mergeMethod = queue ? "queue" : rules.mergeMethod ?? ["merge", "squash", "rebase"].find(m => allowed[m]);
  if (!["merge","squash","rebase","queue"].includes(mergeMethod) || (mergeMethod === "queue" ? !queue : !allowed[mergeMethod])) throw new Error("Project merge method is unavailable");
  return {repository: delivery.repository, targetBranch: delivery.targetBranch, rulesSource: rules.source, rulesDigest: rules.digest,
    ci: requiredChecks.length || requiredWorkflow || observedChecks.length ? "required" : rules.ci,
    local: rules.local, reason: rules.reason, platformRead: "complete", requiredChecks, observedChecks,
    autoMerge: metadata.allow_auto_merge === true, protectedChecks: protectedNames.length > 0
      && requiredChecks.every(name=>protectedNames.includes(name)) && observedChecks.every(name=>protectedNames.includes(name)),
    mergeMethod};
}
export function checkSatisfied(state, verification, local = false) {
  return state === "passed" || state === "not_applicable" && verification?.platformRead === "complete"
    && (local ? verification.local === "not_required" : verification.ci === "not_required"
      && !verification.requiredChecks.length && !verification.observedChecks.length);
}
