import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DevelopmentReviewEvidence } from "@missiongo/domain";

/** Reads only the exact native session's bounded private index. No model,
 * repository scan, subprocess, network, or automatic continuation is involved. */
export async function localDevelopmentReviews(agentKind: string, sessionRef: string, root?: string): Promise<DevelopmentReviewEvidence[] | undefined> {
  const directory = root ?? join(await realpath(homedir()), ".local/state/missiongo-review");
  const read = async (name: string) => {
    const path = join(directory, name + ".json"), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid?.() || info.size > 1024 * 1024) throw new Error("Invalid private review record");
    return JSON.parse(await readFile(path, "utf8"));
  };
  const key = createHash("sha256").update(agentKind + ":" + sessionRef).digest("hex");
  let tasks: unknown;
  try { tasks = await read("session-" + key); } catch { return undefined; }
  if (!Array.isArray(tasks) || tasks.length > 32 || !tasks.every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(id))) return undefined;
  const result: DevelopmentReviewEvidence[] = [];
  for (const taskId of tasks) {
    try {
      const s = await read(taskId), b = s.binding;
      if (s.version !== 1 || s.taskId !== taskId || b.agentKind !== agentKind || b.sessionRef !== sessionRef) throw new Error("Identity mismatch");
      const round = s.rounds.at(-1), final = round?.confirmation?.result ? round.confirmation : round;
      const limitations = (final?.result?.limitations ?? []).filter((item: any) => typeof item === "string" || item.kind === "blocking").map((item: any) => typeof item === "string" ? item : item.detail);
      result.push({ version: 1, taskId, agentKind: b.agentKind, sessionRef, requestId: b.requestId, scopeDigest: b.scopeDigest,
        revision: s.revision, generation: s.generation, status: s.status, round: s.rounds.length, base: b.base,
        ...(b.repositoryUrl ? {repository:b.repositoryUrl} : {}),
        ...(s.candidateDigest ? { candidateDigest: s.candidateDigest } : {}),
        checksPassed: b.requiredChecks.every((name: string) => s.checks?.some((check: any) => check.name === name && check.result === "passed")),
        blockingFindings: (final?.result?.findings ?? []).filter((f: any) => f.severity === "blocking").length,
        findings:final?.result?.findings ?? [], checks:s.checks ?? [], requiredChecks:b.requiredChecks,
        ...(final?.receipt ? {reviewer:{sessionRef:final.receipt.sessionRef,model:final.receipt.model,provider:final.receipt.provider,readOnly:final.receipt.readOnly}} : {}),
        limitations: [...limitations, ...(s.reason ? [s.reason] : [])], ...(s.proof ? { proof: s.proof } : {}) });
    } catch {
      // A known task with missing/corrupt evidence must not disappear as legacy.
      result.push({ version: 1, taskId, agentKind: agentKind as DevelopmentReviewEvidence["agentKind"], sessionRef,
        requestId: "unavailable", scopeDigest: "0".repeat(64), revision: 0, generation: 0, status: "incomplete", round: 0,
        base: "0".repeat(40), checksPassed: false, blockingFindings: 0, limitations: ["Local review evidence unavailable"] });
    }
  }
  return result;
}

export async function localDevelopmentReviewRequired(agentKind: string, sessionRef: string, root?: string): Promise<boolean> {
  try {
    const directory = root ?? join(await realpath(homedir()), ".local/state/missiongo-review");
    const key = createHash("sha256").update(agentKind + ":" + sessionRef).digest("hex");
    const path = join(directory,"policy-"+key+".json"), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid?.() || info.size > 4096) return false;
    const value = JSON.parse(await readFile(path,"utf8"));
    return value.version === 1 && value.agentKind === agentKind && value.sessionRef === sessionRef && value.required === true;
  } catch { return false; }
}
