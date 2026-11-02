import type { AgentKind } from "@missiongo/domain";

export type Kind = Exclude<AgentKind, "hermes">;
export interface Dispatch {
  dispatchId: string; itemKeys: string[]; repoPath: string; agentKind: Kind; mode: string;
  nodeName?: string; model?: string; effort?: string; reworkItemKeys?: string[];
}
export interface AgentConfig { executable?: string }
export interface RepoMapping { productId: string; repoPath: string; productKey?: string }
export interface Config {
  installationId: string; server?: string; nodeId?: string; name?: string; token?: string;
  agents: Partial<Record<Kind, AgentConfig>>;
}
export interface Question {
  title: string; key?: string; header?: string; detail?: string; options?: string[];
  kind?: "text" | "number" | "boolean"; multiSelect?: boolean; custom?: boolean; answered?: string;
}
export interface Message {
  sourceId: string; role: "user" | "agent" | "plan"; text: string; turnId?: string;
  occurredAt?: string; questions?: Question[];
}
export interface Approval {
  id: string; kind: "manual" | "auto"; status: string; turnId: string; action: string;
  reason?: string; startedAtMs: number; options?: { id: string; kind: string; label?: string; detail?: string }[];
}
export interface Command {
  id: string; kind?: string; text: string; turnId?: string; status: string;
  attachments?: { id: string; filename: string; sizeBytes: number }[];
}
export interface Session {
  id: string; dispatchId?: string; agentKind: Kind; sessionRef: string; lifecycle?: string;
  occupiesExecutionSlot?: boolean; command?: Command; approvalDecision?: { id: string; choice: string };
  approvalRetry?: { id: string; reviewId: string; status: string }; approvalReviewMode?: string;
  desiredSettings?: { revision: number; mode?: string; model?: string; effort?: string };
  appliedSettingsRevision?: number; archiveInSource?: boolean; restoreInSource?: boolean;
}
export interface Snapshot {
  status: "active" | "idle" | "suspended" | "stalled" | "unavailable" | "failed";
  messages: Message[]; activities?: { id: string; title: string; detail?: string }[];
  turnActive?: boolean; waitingForInput?: boolean; error?: string; model?: string; effort?: string;
  approval?: Approval; commandId?: string; commandStatus?: string; commandError?: string;
  sourceArchived?: boolean; sourceRestored?: boolean; sourceArchiveError?: string;
  settingsRevision?: number; settingsError?: string;
  approvalRetryId?: string; approvalRetryStatus?: string; approvalRetryError?: string;
}
export interface HostState {
  dispatch: Dispatch; pid: number; sessionRef?: string; sessionName: string;
  phase: "starting" | "launched" | "failed"; snapshot: Snapshot; launchError?: string;
  commands: Record<string, { status: string; error?: string }>;
}
export interface Adapter {
  start(prompt: string): Promise<string>;
  snapshot(): Promise<Snapshot>;
  deliver(command: Command): Promise<void>;
  decide(decision: { id: string; choice: string }): Promise<void>;
  settings?(settings: NonNullable<Session["desiredSettings"]>): Promise<void>;
  archive?(restore: boolean): Promise<void>;
  retryApproval?(retry: NonNullable<Session["approvalRetry"]>): Promise<void>;
  close(): Promise<void>;
}
// Dynamic data is decoded at each protocol boundary; never use it as shell text.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Wire = Record<string, any>;
export function object(value: unknown): Wire {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid protocol object");
  return value as Wire;
}
export function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,150}$/.test(value)) throw new Error("Invalid identifier");
  return value;
}
/** A local precondition rejected input before any native side effect. */
export class InputRejected extends Error {}
