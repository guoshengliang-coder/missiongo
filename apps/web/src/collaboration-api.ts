import { request } from "./api";
import type { WorkItemStatus } from "./types";
export interface Grant {
  id: string;
  sourceProductId: string;
  targetProductId: string;
  sourceName: string;
  targetName: string;
  moduleId: string;
  moduleName?: string;
  builderAccountId: string | null;
  enabled: boolean;
  revision: number;
}
export interface Draft {
  id: string;
  version: number;
  grantId: string;
  title: string;
  description: string;
  acceptance: string;
  attachmentIds: string[];
  type: "bug" | "requirement";
  priority: "urgent" | "high" | "normal" | "low";
  agentName?: string;
}
export interface Relation {
  id: string;
  revision: number;
  direction: "outgoing" | "incoming";
  sourceKey: string;
  targetKey: string;
  targetTitle: string;
  sourceProductName: string;
  targetProductName: string;
  status: WorkItemStatus;
  builderName: string;
  verifierName: string;
  verifierAccountId: string;
  withdrawn: boolean;
  blocking: boolean;
  restricted?: boolean;
  canManageAccess?: boolean;
  canWithdraw?: boolean;
}
export interface CollaborationContext {
  blocked: boolean;
  requests: Relation[];
  drafts: Draft[];
  canRequest: boolean;
}
export interface CollaborationDetail extends Relation {
  request: Draft & { attachments: Array<{ id: string; filename: string }> };
  targetRevision: number;
  canVerify: boolean;
  canTransferVerifier: boolean;
  canManageAccess: boolean;
  canDeliver: boolean;
  canDiscuss: boolean;
  canWithdraw: boolean;
  events: Array<{
    id: string;
    kind: string;
    actorName: string;
    actorKind: "human" | "agent" | "system";
    payload: { note?: string; to?: string; from?: string };
    createdAt: string;
  }>;
}
const path = (v: string) => encodeURIComponent(v),
  write = <T>(url: string, body: unknown, method = "POST") =>
    request<T>(url, { method, body: JSON.stringify(body) });
export const collaborationApi = {
  context: (key: string) =>
    request<CollaborationContext>(`/api/v1/items/${path(key)}/collaboration`),
  targets: (key: string) =>
    request<{ targets: Grant[] }>(
      `/api/v1/items/${path(key)}/collaboration/targets`,
    ),
  directory: (productId: string) =>
    request<{ projects: Array<{ id: string; name: string }> }>(
      `/api/v1/products/${path(productId)}/collaboration/directory`,
    ),
  candidates: (id: string) =>
    request<{ people: Array<{ id: string; name: string }> }>(
      `/api/v1/collaboration/${path(id)}/candidates`,
    ),
  grants: (productId: string) =>
    request<{ grants: Grant[] }>(
      `/api/v1/products/${path(productId)}/collaboration`,
    ),
  configure: (productId: string, body: unknown) =>
    write<Grant>(
      `/api/v1/products/${path(productId)}/collaboration`,
      body,
      "PUT",
    ),
  prepare: (key: string, body: unknown) =>
    write<Draft>(`/api/v1/items/${path(key)}/collaboration/drafts`, body),
  submit: (draft: Draft, idempotencyKey: string) =>
    write<{ id: string }>(
      `/api/v1/collaboration/drafts/${path(draft.id)}/submit`,
      { version: draft.version, approved: true, idempotencyKey },
    ),
  detail: (id: string) =>
    request<CollaborationDetail>(`/api/v1/collaboration/${path(id)}`),
  command: (id: string, action: string, body: unknown) =>
    write<{ id: string }>(`/api/v1/collaboration/${path(id)}/${action}`, body),
  associate: (key: string, body: unknown) =>
    write<{ id: string }>(
      `/api/v1/items/${path(key)}/collaboration/associate`,
      body,
    ),
  attachment: (id: string, attachmentId: string) =>
    `/api/v1/collaboration/${path(id)}/attachments/${path(attachmentId)}`,
};
