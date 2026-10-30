import { createHash } from "node:crypto";

import type { AgentApproval } from "./agent-approval-store.js";
import type { AgentSessionSnapshot } from "./agent-session-store.js";
import { conflict } from "./errors.js";

export interface PlanApprovalDecision {
  readonly canApprove: boolean;
  readonly reason: string;
  readonly evidence: string;
}

export interface PlanApprovalOffer {
  readonly revision: string;
  readonly reason: string;
  readonly evidence: string;
}

type Session = AgentSessionSnapshot & { readonly canReply: boolean; readonly approval?: AgentApproval };
interface Candidate { revision: string; requestRevision: string; content: string; latestText: string }
interface Entry { revision: string; requestRevision: string; decision?: PlanApprovalDecision; retryAt?: number; consumed?: boolean }

/** Only prose can support an offer; quoted examples and fenced code cannot. */
export function approvalProse(text: string): string {
  let fence: string | undefined;
  return text.split("\n").filter((line) => {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^\s*[`~]+\s*$/u.test(line)) fence = undefined;
      return false;
    }
    return !fence && !/^\s*>/u.test(line) && !/^(?: {4}|\t)/u.test(line);
  }).join("\n");
}

function candidate(session: Session): Candidate | undefined {
  if (!session.canReply || session.managedExecution || session.archivedAt || session.lastError
    || session.status !== "idle" || session.turnState.turnActive === true
    || (session.nativeConnection && session.nativeConnection.state !== "connected")) return;
  // Source permission requests have their own decision protocol, never chat approval.
  if (session.approval && !["approved", "resolved"].includes(session.approval.status)) return;
  const command = session.command;
  if (command && ["queued", "delivering", "delivery_unknown"].includes(command.status)) return;
  const latest = session.messages.at(-1);
  if (!latest || !["agent", "plan"].includes(latest.role) || latest.phase === "commentary") return;
  if (session.messages.some((message) => message.questions?.some((q) => !q.answered && !q.withdrawn))) return;
  // A delivered reply may precede its source echo. Never offer to approve the old request again.
  if (command?.status === "delivered" && (!latest.occurredAt
    || Date.parse(command.createdAt) >= Date.parse(latest.occurredAt))) return;
  const messages = session.messages.slice(-12).map(({ sourceId, role, text, questions }) => ({ sourceId, role, text, questions }));
  const content = JSON.stringify({ messages });
  // Do not clip a plan or a question to fit the classifier's input budget.
  if (content.length > 20_000 || !approvalProse(latest.text).trim()) return;
  const revision = createHash("sha256").update(JSON.stringify([
    session.id, session.messages, session.status, session.turnState.turnActive ?? false,
    session.turnState.waitingForInput ?? false, command, session.approval,
    session.nativeConnection?.nodeId,
  ])).digest("hex");
  const requestRevision = createHash("sha256").update(JSON.stringify(latest)).digest("hex");
  return { revision, requestRevision, content, latestText: latest.text };
}

/** Process-local, bounded cache. Restarting requires a new AI verdict, never a permissive fallback. */
export class PlanApprovalService {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly classify: (content: string, latestText: string) => Promise<PlanApprovalDecision>) {}

  inspect(session: Session, enabled: boolean): PlanApprovalOffer | undefined {
    const input = enabled ? candidate(session) : undefined;
    let entry = this.entries.get(session.id);
    if (!input) {
      // Keep a consumed request through queueing and delivery, including source clock skew.
      if (!entry?.consumed) this.entries.delete(session.id);
      return;
    }
    if (entry?.consumed && entry.requestRevision === input.requestRevision) return;
    if (entry?.revision !== input.revision || (entry.retryAt !== undefined && Date.now() >= entry.retryAt)) {
      entry = { revision: input.revision, requestRevision: input.requestRevision };
      this.entries.delete(session.id);
      this.entries.set(session.id, entry);
      if (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value!);
      const pending = entry;
      void this.classify(input.content, input.latestText).then((decision) => {
        if (this.entries.get(session.id) === pending) pending.decision = decision;
      }).catch(() => {
        // No raw model error or conversation text in logs. Retry failures at most once a minute.
        if (this.entries.get(session.id) === pending) pending.retryAt = Date.now() + 60_000;
      });
    }
    return entry.decision?.canApprove && !entry.consumed
      ? { revision: entry.revision, reason: entry.decision.reason, evidence: entry.decision.evidence }
      : undefined;
  }

  /** Called synchronously with reloading and queueing inside the caller's DB transaction. */
  approve<T>(session: Session, revision: string, enabled: boolean, enqueue: () => T): T {
    const input = enabled ? candidate(session) : undefined;
    const entry = this.entries.get(session.id);
    if (!input || input.revision !== revision || entry?.revision !== revision
      || !entry.decision?.canApprove || entry.consumed) {
      throw conflict("agent_plan_approval_changed", "The approval request changed or is unavailable. Refresh and review the conversation before approving.");
    }
    const result = enqueue();
    entry.consumed = true;
    return result;
  }
}
