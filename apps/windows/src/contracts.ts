import type { AgentConfig, Kind, RepoMapping } from "../../node/src/types.js";

export interface DesktopPreferences {
  runtime: "native" | "wsl";
  distribution: string;
  wslNodeExecutable?: string;
  launchAtLogin: boolean;
  startHidden: boolean;
  notifications: boolean;
}
export interface DesktopUpdate { state: "idle" | "checking" | "current" | "available" | "downloading" | "cancelling" | "cancelled" | "verifying" | "ready" | "installing" | "failed"; version?: string | undefined; error?: string; notes?: string; percent?: number; transferred?: number; total?: number }
export interface DesktopSnapshot {
  runtimeError?: string;
  version: string;
  registered: boolean;
  server?: string;
  name?: string;
  running: boolean;
  loginPending: boolean;
  managedEnabled: boolean;
  agents: Partial<Record<Kind, AgentConfig>>;
  health?: { state?: string; checkedAt?: string; agents?: { kind: string; ready: boolean; version?: string; unavailableReason?: string; modes?: {mode:string; state:string; model?:string}[]; skill?: {syncState:string} }[] };
  products: { id: string; name: string; keyPrefix: string }[];
  repos: RepoMapping[];
  preferences: DesktopPreferences;
  distributions: string[];
  update?: DesktopUpdate;
}
export type DesktopRequest =
  | { method: "snapshot" | "cancelLogin" | "logout" | "openConsole" | "checkUpdates" | "installUpdate" | "cancelUpdate" }
  | { method: "login"; server: string; name: string }
  | { method: "agent"; kind: Kind; enabled: boolean; settings: AgentConfig }
  | { method: "checkAgent"; kind?: Kind }
  | { method: "repository"; productId: string; path?: string }
  | { method: "rename"; name: string }
  | { method: "run"; enabled: boolean }
  | { method: "managed"; enabled: boolean }
  | { method: "preferences"; value: DesktopPreferences }
  | { method: "chooseDirectory" | "chooseFile" | "listDistributions" | "copyBridgeCommand" };
export type DesktopEvent = { type: "authorization"; url: string; code: string } | { type: "status"; text: string } | { type: "attention" };
export interface DesktopBridge {
  request<T = unknown>(request: DesktopRequest): Promise<T>;
  subscribe(callback: (event: DesktopEvent) => void): () => void;
}
