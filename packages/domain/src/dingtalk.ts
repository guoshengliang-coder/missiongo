export type DingTalkDeliveryMode = "work_notice" | "robot";
/** Server-owned DingTalk configuration. Secrets never appear in snapshots. */
export interface DingTalkSettings {
  corpId: string;
  clientId: string;
  agentId: string;
  deliveryMode: DingTalkDeliveryMode;
  robotCode: string;
  configured: boolean;
  revision: number;
}
export interface DingTalkSettingsInput {
  corpId: string;
  clientId: string;
  agentId: string;
  deliveryMode?: DingTalkDeliveryMode;
  robotCode?: string;
  clientSecret?: string;
  expectedRevision: number;
}
export interface DingTalkBindingInput {
  userId: string;
  name: string;
  department: string;
}
export interface DingTalkBinding extends DingTalkBindingInput {
  accountId: string;
  revision: string;
}
export interface DingTalkImportRow extends DingTalkBindingInput { email: string }
export interface DingTalkImportPreview {
  fingerprint: string;
  rows: Array<DingTalkImportRow & { accountId?: string; issue?: string }>;
}
export type DingTalkNotificationStatus = "queued" | "sending" | "accepted" | "sent" | "failed" | "skipped" | "uncertain";
export interface DingTalkNotification {
  id: string;
  kind: "verification" | "test";
  status: DingTalkNotificationStatus;
  reason: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}
export interface DingTalkProjectSettings {
  enabled: boolean;
  canConfigure: boolean;
  integrationConfigured: boolean;
}
