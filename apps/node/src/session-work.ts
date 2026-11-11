import { createHash } from "node:crypto";
import type { Session, Snapshot } from "./types.js";

/** FIFO across identities; at most one running and one replacement per key. */
export class SessionWorkQueue {
  private pending = new Map<string, () => Promise<void>>();
  private running = new Set<string>();
  private closing = false;
  private idle: (() => void)[] = [];
  constructor(private readonly onError: (error: unknown) => void, private readonly limit = 4) {}
  submit(key: string, work: () => Promise<void>): void {
    if (this.closing) return;
    this.pending.set(key, work); this.drain();
  }
  private drain(): void {
    for (const [key, work] of this.pending) {
      if (this.running.size >= this.limit) break;
      if (this.running.has(key)) continue;
      this.pending.delete(key); this.running.add(key);
      void work().catch(this.onError).finally(() => {
        this.running.delete(key); this.drain();
        if (!this.running.size && !this.pending.size) for (const resolve of this.idle.splice(0)) resolve();
      });
    }
  }
  async finish(): Promise<void> {
    this.closing = true; this.pending.clear();
    if (this.running.size) await new Promise<void>(resolve => this.idle.push(resolve));
  }
}
export class SessionUploadGate {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work); this.tails.set(key, next);
    try { return await next; } finally { if (this.tails.get(key) === next) this.tails.delete(key); }
  }
}
export function hasControlWork(session: Session): boolean {
  return !!(session.command || session.approvalDecision || session.approvalRetry || session.archiveInSource || session.restoreInSource
    || session.lifecycle === "close" || session.desiredSettings && session.desiredSettings.revision > (session.appliedSettingsRevision ?? 0));
}
export function observationSession(session: Session): Session {
  const {command: _command, approvalDecision: _decision, approvalRetry: _retry, desiredSettings: _settings,
    archiveInSource: _archive, restoreInSource: _restore, ...rest} = session;
  return {...rest, lifecycle: "keep"};
}
export class SnapshotReports {
  private accepted = new Map<string, {hash: string; at: number}>();
  fingerprint(snapshot: Snapshot): string { return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"); }
  needed(key: string, hash: string, now = Date.now()): boolean {
    const previous = this.accepted.get(key);
    return !previous || previous.hash !== hash || now - previous.at >= 30_000;
  }
  confirm(key: string, hash: string, now = Date.now()): void { this.accepted.set(key, {hash, at:now}); }
  failed(key: string): void { this.accepted.delete(key); }
}

/** Observation freshness is not progress. Control receipts never enter here. */
export class SnapshotHealth {
  private observations = new Map<string, {hash: string; observed: number; progress: number}>();
  observe(key: string, report: Snapshot, now = Date.now()): Snapshot {
    if (report.status === "unavailable") return report;
    const hash = JSON.stringify([report.status, report.messages, report.activities, report.turnActive, report.waitingForInput]);
    const previous = this.observations.get(key);
    const same = previous?.hash === hash;
    const current = {hash, progress: same ? previous.progress : now,
      observed: same && now - previous.observed < 30_000 ? previous.observed : now};
    this.observations.set(key, current);
    return {...report, observedAt:new Date(current.observed).toISOString(), lastProgressAt:new Date(current.progress).toISOString()};
  }
}

/** Receipts remain retryable; an old receipt must not restore pre-stop state. */
export class ControlReports {
  private latest = new Map<string, {epoch: number; snapshot: Snapshot}>();
  private resultEpochs = new Map<string, number>();
  record(id: string, epoch: number, snapshot: Snapshot): Snapshot {
    const key = snapshot.commandId ? id + ":" + snapshot.commandId + ":" + snapshot.commandStatus : undefined;
    const observed = key ? this.resultEpochs.get(key) ?? epoch : epoch;
    if (key) this.resultEpochs.set(key, observed);
    const latest = this.latest.get(id);
    if (latest && latest.epoch > observed) {
      const result: Snapshot = {status:latest.snapshot.status, messages:[],
        ...(snapshot.settingsRevision === undefined ? {} : {settingsRevision:snapshot.settingsRevision}),
        ...(snapshot.settingsError === undefined ? {} : {settingsError:snapshot.settingsError}),
        ...(snapshot.sourceArchived === undefined ? {} : {sourceArchived:snapshot.sourceArchived}),
        ...(snapshot.sourceRestored === undefined ? {} : {sourceRestored:snapshot.sourceRestored}),
        ...(snapshot.sourceArchiveError === undefined ? {} : {sourceArchiveError:snapshot.sourceArchiveError}),
        ...(latest.snapshot.turnActive === undefined ? {} : {turnActive:latest.snapshot.turnActive}),
        ...(latest.snapshot.waitingForInput === undefined ? {} : {waitingForInput:latest.snapshot.waitingForInput})};
      for (const field of ["commandId", "commandStatus", "commandError", "approvalRetryId", "approvalRetryStatus", "approvalRetryError"] as const) {
        if (snapshot[field] !== undefined) result[field] = snapshot[field];
      }
      return result;
    }
    this.latest.set(id, {epoch:observed, snapshot});
    return snapshot;
  }
}
