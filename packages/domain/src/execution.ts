export const EXECUTION_MODES = ["analyze", "process", "continue", "verify"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const EXECUTION_STATUSES = [
  "created",
  "running",
  "waiting_for_human",
  "succeeded",
  "failed",
  "aborted",
  "lease_expired",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const EXECUTION_TRIGGER_SOURCES = ["agent_pull", "web_dispatch", "android_dispatch", "scheduler"] as const;
export type ExecutionTriggerSource = (typeof EXECUTION_TRIGGER_SOURCES)[number];

export interface ExecutionReport {
  readonly conclusion: string;
  readonly rootCause?: string;
  readonly changeSummary: string;
  readonly affectedFiles: readonly string[];
  readonly branch?: string;
  readonly commit?: string;
  readonly checks: readonly ExecutionCheck[];
  readonly remainingRisks: readonly string[];
  readonly manualVerificationSteps: readonly string[];
}

export interface ExecutionCheck {
  readonly name: string;
  readonly command?: string;
  readonly outcome: "passed" | "failed" | "skipped";
  readonly summary: string;
}
