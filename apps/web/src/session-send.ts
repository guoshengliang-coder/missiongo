import { api, ApiError } from "./api";
import type { AgentSessionCommand } from "./types";

export interface SendInput {
  sessionId: string; text: string; files: readonly File[]; occurredAt: string;
  preserveDraft?: boolean; recovery?: "check" | "retry"; requestKey?: string;
}
export interface SendAttempt extends SendInput {
  requestKey: string; uploaded: string[];
  phase: "uploading" | "submitting" | "checking" | "unconfirmed" | "failed" | "sent";
  error?: unknown; command?: AgentSessionCommand;
}
export class SendUnconfirmed extends Error {}
export class SendSuperseded extends Error {}
export function commandNotDelivered(command: AgentSessionCommand | undefined) {
  return command?.status === "cancelled" || command?.status === "failed";
}
export function sendAttemptHasDraft(attempt: SendAttempt | undefined) {
  return Boolean(attempt && !attempt.preserveDraft && (attempt.phase !== "sent" || commandNotDelivered(attempt.command)));
}

/** Owned by the page, never by a selected row. All replays use frozen parameters. */
export class SessionSender {
  private attempts = new Map<string, SendAttempt>();
  private busy = new Map<string, Promise<AgentSessionCommand>>();
  private listeners = new Set<() => void>();
  constructor(private readonly transport: Pick<typeof api, "getAgentSendRequest" | "uploadAgentSessionAttachment" | "sendAgentSessionCommand"> & Partial<Pick<typeof api, "deleteAgentSessionAttachment">> = api, private readonly onSent?: (input: SendAttempt) => void) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = (sessionId: string) => this.attempts.get(sessionId);
  private update(attempt: SendAttempt, patch: Partial<SendAttempt>) {
    const next = { ...attempt, ...patch };
    if (this.get(attempt.sessionId)?.requestKey !== attempt.requestKey) return next;
    this.attempts.set(attempt.sessionId, next);
    this.listeners.forEach(listener => listener());
    return next;
  }
  private assertCurrent(attempt: SendAttempt) {
    if (this.get(attempt.sessionId)?.requestKey !== attempt.requestKey) throw new SendSuperseded("The local send attempt was cleared.");
  }
  clear() { this.busy.clear(); this.attempts.clear(); this.listeners.forEach(listener => listener()); }
  send(input: SendInput): Promise<AgentSessionCommand> {
    let attempt = this.get(input.sessionId);
    if (input.recovery && (!attempt || (input.requestKey !== undefined && input.requestKey !== attempt.requestKey))) {
      return Promise.reject(new SendSuperseded("The recovery action no longer matches this send."));
    }
    const running = this.busy.get(input.sessionId);
    if (running) return running;
    if (input.recovery && attempt?.phase === "sent" && attempt.command) return Promise.resolve(attempt.command);
    let abandoned: SendAttempt | undefined;
    const unresolved = attempt && ["submitting", "checking", "unconfirmed"].includes(attempt.phase);
    if (!attempt || attempt.phase === "sent" || (!input.recovery && !unresolved && (attempt.text !== input.text
      || attempt.files.length !== input.files.length || attempt.files.some((file, i) => file !== input.files[i])))) {
      if (attempt?.phase === "failed") abandoned = attempt;
      attempt = { ...input, requestKey: crypto.randomUUID(), uploaded: [], phase: "uploading" };
      this.attempts.set(input.sessionId, attempt);
    }
    const frozen = attempt;
    // Register the promise synchronously, before invoking any transport or listener.
    const promise = Promise.resolve().then(async () => {
      this.assertCurrent(frozen);
      if (abandoned) await Promise.allSettled(abandoned.uploaded.map(id => this.transport.deleteAgentSessionAttachment?.(abandoned!.sessionId, id)));
      return this.run(frozen, Boolean(unresolved), input.recovery);
    });
    this.busy.set(input.sessionId, promise);
    void promise.finally(() => { if (this.busy.get(input.sessionId) === promise) this.busy.delete(input.sessionId); }).catch(() => {});
    return promise;
  }
  private async run(original: SendAttempt, uncertain: boolean, recovery?: SendInput["recovery"]): Promise<AgentSessionCommand> {
    let attempt = original;
    this.assertCurrent(attempt);
    if (uncertain) {
      attempt = this.update(attempt, { phase: "checking" });
      try {
        const result = await this.transport.getAgentSendRequest(attempt.sessionId, attempt.requestKey);
        this.assertCurrent(attempt);
        if (result.command) return this.finish(attempt, result.command);
      } catch (error) {
        this.assertCurrent(attempt);
        this.update(attempt, { phase: "unconfirmed", error });
        throw new SendUnconfirmed();
      }
      if (recovery !== "retry") {
        this.update(attempt, { phase: "unconfirmed" });
        throw new SendUnconfirmed();
      }
    }
    try {
      attempt = this.update(attempt, { phase: "uploading", error: undefined });
      for (let index = attempt.uploaded.length; index < attempt.files.length; index++) {
        const file = await this.transport.uploadAgentSessionAttachment(attempt.sessionId, attempt.files[index]!, `${attempt.requestKey}-${index}`);
        this.assertCurrent(attempt);
        attempt = this.update(attempt, { uploaded: [...attempt.uploaded, file.id] });
      }
    } catch (error) {
      this.assertCurrent(attempt);
      this.update(attempt, { phase: "failed", error });
      throw error;
    }
    this.assertCurrent(attempt);
    attempt = this.update(attempt, { phase: "submitting" });
    try {
      return this.finish(attempt, await this.transport.sendAgentSessionCommand(attempt.sessionId, attempt.text, attempt.uploaded, attempt.requestKey));
    } catch (error) {
      this.assertCurrent(attempt);
      if (!uncertain && error instanceof ApiError && error.status >= 400 && error.status < 500) {
        this.update(attempt, { phase: "failed", error });
        throw error;
      }
      attempt = this.update(attempt, { phase: "checking", error });
      try {
        const result = await this.transport.getAgentSendRequest(attempt.sessionId, attempt.requestKey);
        this.assertCurrent(attempt);
        if (result.command) return this.finish(attempt, result.command);
      } catch { this.assertCurrent(attempt); /* A read failure proves nothing about submission. */ }
      this.update(attempt, { phase: "unconfirmed", error });
      throw new SendUnconfirmed();
    }
  }
  private finish(attempt: SendAttempt, command: AgentSessionCommand) {
    this.assertCurrent(attempt);
    const keepDraft = commandNotDelivered(command);
    this.update(attempt, { phase: "sent", command, files: keepDraft ? attempt.files : [], uploaded: [], error: undefined });
    if (!keepDraft) this.onSent?.(attempt);
    return command;
  }
}
