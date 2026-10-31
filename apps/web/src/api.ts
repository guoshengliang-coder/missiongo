import type { CommentAudienceInput, CommentCandidate } from "@missiongo/domain";
import type { ItemFilters } from "@missiongo/domain";
import { appendItemFilters } from "./item-filters";
import type { AgentArtifactBundle, AgentArtifactState } from "@missiongo/domain";
import type { CompletionReference } from "@missiongo/contracts";
import type { InsightQuery, InsightSummary, InsightDetails, InsightDetailSelection, InsightBatch, InsightBatchSummary, InsightBatchProgress } from "@missiongo/domain";
import type { ManagedDecision, ManagedDecisionGuard } from "@missiongo/domain";
import { attachmentPreviewPath, attachmentThumbnailPath } from "./attachment-thumbnail";
import type { FontScale } from "./font-scale";
import type { DingTalkSettings, DingTalkSettingsInput, DingTalkBinding, DingTalkBindingInput, DingTalkImportRow, DingTalkImportPreview, DingTalkNotification, DingTalkProjectSettings } from "@missiongo/domain";
import type {
  ActiveDispatch,
  RedispatchEligibility,
  ItemDispatchHandler,
  ItemDispatchSummary,
  AgentSession,
  AgentSessionCommand,
  AgentSessionAttachment,
  AgentSessionSettings,
  AgentSessionSummary,
  Component,
  CreatedSdkToken,
  CreateDispatchInput,
  SdkToken,
  ComponentKind,
  CreateWorkItemInput,
  Dispatch,
  DispatchHealthSnapshot,
  DispatchDefaults,
  DispatchNode,
  NodeRepoMapping,
  Product,
  TransitionAction,
  UpdateWorkItemInput,
  WorkItem,
  WorkItemAttachment,
  WorkItemComment,
  WorkItemEvent,
  WorkItemStatus,
  WorkItemType,
} from "./types";

export interface WorkItemListPage {
  readonly items: WorkItem[];
  readonly nextBeforeSequence?: number;
  readonly summary: {
    /** Items matching the active type and search filters, across every status. */
    readonly total: number;
    /** Per-status counts under the same filters, so each sidebar entry stays honest. */
    readonly byStatus: Readonly<Record<WorkItemStatus, number>>;
    /** Every item in the product, so the list can say "12 of 40". */
    readonly productTotal: number;
  };
}

export interface ListItemsOptions extends ItemFilters {
  readonly builder?: string;
  readonly status?: WorkItemStatus;
  readonly type?: WorkItemType;
  readonly search?: string;
  readonly limit?: number;
  readonly beforeSequence?: number;
}

export type AccountRole = "admin" | "member";

export interface AuthenticatedUser {
  readonly id: string;
  /** The email address the account signs in with. */
  readonly username: string;
  /** What to show on screen: the nickname, or the address up to the @. Never empty. */
  readonly displayName: string;
  /** The nickname as stored. Absent when none is set -- see account-nickname.ts. */
  readonly nickname?: string;
  /** The console type size this account reads at (AND-247). */
  readonly fontScale: FontScale;
  /** The Agent console chat body's own size, chosen independently of fontScale (AND-254). */
  readonly consoleFontScale: FontScale;
  readonly role: AccountRole;
}

export interface AuthSession {
  readonly user: AuthenticatedUser;
}

/** What one account may do with one product. Three switches, not a ranked scale. */
export interface ProductPermission {
  readonly productId: string;
  readonly canView: boolean;
  readonly canOperate: boolean;
  readonly canUseAi: boolean;
}

/** One AI client standing authorized against your account. */
export interface AiAuthorization {
  readonly id: string;
  readonly clientId: string;
  /** The client's registered name, decoded from its signed id when it is still readable. */
  readonly clientName?: string;
  readonly scopes: string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt?: string;
  /** 'pat' entries were minted in the console for machines (AND-288). */
  readonly kind?: "oauth" | "pat";
  /** The name given to a personal access token. */
  readonly name?: string;
}

/** A freshly minted personal access token; `token` is shown once, never again. */
export interface PersonalTokenCreated {
  readonly id: string;
  readonly name: string;
  readonly token: string;
  readonly scopes: string[];
  readonly expiresAt: string;
}

/**
 * Just enough of an account to name it in the product-side editor.
 *
 * This is what the route actually sends, and it used to be typed as `Account`,
 * which claimed a `permissions` field that was never there. It stays this narrow
 * on purpose: a product's creator can read this list now, so it must not carry
 * when some other account last changed its password.
 */
export interface AccountSummary {
  readonly id: string;
  readonly email: string;
  readonly role: AccountRole;
}

/** One account's standing on one product, as the product-side editor shows it. */
export interface ProductAccessEntry {
  readonly account: AccountSummary;
  readonly permission: ProductPermission;
  /** True for an administrator, who reaches the product whatever the row says. */
  readonly reachesByRole: boolean;
  /** What the account can actually do with this product; for an administrator, more than its row (AND-63). */
  readonly effective: Omit<ProductPermission, "productId">;
}

export interface Account {
  readonly projectAdministratorProductIds?: readonly string[];
  readonly id: string;
  readonly email: string;
  readonly nickname?: string;
  readonly role: AccountRole;
  readonly disabledAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly permissions: ProductPermission[];
}

export type BulkTransitionResult =
  | { readonly itemKey: string; readonly ok: true }
  | { readonly itemKey: string; readonly ok: false; readonly code: string; readonly message: string };

export interface ManagedDecisionView {
  readonly decision: ManagedDecision;
  readonly productName: string;
  readonly access: { readonly canApprove: boolean; readonly canRevoke: boolean };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Every request gets a deadline: a fetch that never answers used to leave the
 * send button disabled and the poll backoff frozen forever, because no error
 * ever arrived to count (AND-224). JSON calls stay short; file transfers get
 * a wider budget since their size is the reason they are slow.
 */
const REQUEST_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 300_000;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    // A caller's own signal wins; otherwise this request ends on a deadline.
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { code?: string; title?: string } | null;
    throw new ApiError(response.status, problem?.code ?? "request_failed", problem?.title ?? "Request failed.");
  }
  return response.json() as Promise<T>;
}

async function attachmentRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    signal: init.signal ?? AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { code?: string; title?: string } | null;
    throw new ApiError(response.status, problem?.code ?? "request_failed", problem?.title ?? "Request failed.");
  }
  return response;
}

/**
 * A 204 carries no body, so it cannot go through `request`, whose last step is
 * `response.json()`. Reuses the same problem+json error handling as everything
 * else rather than re-implementing it for the two endpoints that answer empty.
 */
async function requestNoContent(path: string, init: RequestInit = {}): Promise<void> {
  await attachmentRequest(path, init);
}

/**
 * Where to point an `<img>` at a product's icon.
 *
 * `updatedAt` moves whenever the icon is replaced and matches the server's ETag,
 * so it doubles as the cache buster: the browser may keep the image across cold
 * starts, and a replaced icon still appears at once under its new URL.
 */
export function productIconUrl(product: Pick<Product, "id" | "updatedAt">): string {
  return `/api/v1/products/${encodeURIComponent(product.id)}/icon?v=${encodeURIComponent(product.updatedAt)}`;
}

/**
 * The first screen, in one response. Replaces the `/auth/session` ->
 * `/products` -> `/items` chain, which cost three round trips before anything
 * could render. `productId` is resolved by the server: it is the requested one
 * when that product still exists, the first product otherwise, and null when the
 * workspace has none.
 */
export interface Bootstrap {
  readonly user: AuthenticatedUser;
  readonly products: Product[];
  readonly productId: string | null;
  readonly items: WorkItem[];
  readonly components: Component[];
  readonly summary?: WorkItemListPage["summary"];
  readonly nextBeforeSequence?: number;
}

export interface StatusCheckRecord {
  id: string; itemKey: string; productId: string; itemStatus: WorkItemStatus; pullRequestUrl: string; completion: CompletionReference;
  requiredArtifacts: string[] | null; noReleaseReason: string | null; status: string; reason: string;
  lastResultAt?: string | null; checkedAt: string | null; requestedAt: string | null; evidenceUpdatedAt: string; evidenceSource: string; evidenceReporter?: {accountId?:string;note?:string;recordedAt?:string};
  evidence: { merged?: {commit: string; occurredAt: string}; releases?: Array<{artifact:string;version:string;sourceCommit:string;verifiedAt:string}> };
}
export interface StatusCheckPage { items: StatusCheckRecord[]; nextOffset?: number; queued?: number; missingAssociation?: boolean;
  schedule?: {time:string|false;timezone:string;frequency:string} }

function insightSearch(input: InsightQuery & {productIds?: string[]} & Partial<InsightDetailSelection>): string {
  const params = new URLSearchParams();
  for (const [key,value] of Object.entries(input)) {
    if (value === undefined || key === "includeTrend") continue;
    params.set(key,Array.isArray(value) ? value.join(",") : String(value));
  }
  return params.toString();
}

export const api = {
  dingtalkSettings: () => request<DingTalkSettings>("/api/v1/dingtalk/settings"),
  saveDingtalkSettings: (input: DingTalkSettingsInput) => request<DingTalkSettings>("/api/v1/dingtalk/settings",{method:"PUT",body:JSON.stringify(input)}),
  checkDingtalk: () => request<{available:boolean}>("/api/v1/dingtalk/check",{method:"POST"}),
  dingtalkBindings: () => request<{bindings:DingTalkBinding[];tests:Record<string,DingTalkNotification>}>("/api/v1/dingtalk/bindings"),
  saveDingtalkBinding: (accountId:string,binding:DingTalkBindingInput|null,expectedRevision:string|null) => request<{bindings:DingTalkBinding[]}>(`/api/v1/dingtalk/bindings/${encodeURIComponent(accountId)}`,{method:"PUT",body:JSON.stringify({binding,expectedRevision})}),
  previewDingtalkBindings: (rows:DingTalkImportRow[]) => request<DingTalkImportPreview>("/api/v1/dingtalk/bindings/preview",{method:"POST",body:JSON.stringify({rows})}),
  importDingtalkBindings: (rows:DingTalkImportRow[],fingerprint:string) => request<{bindings:DingTalkBinding[]}>("/api/v1/dingtalk/bindings/import",{method:"POST",body:JSON.stringify({rows,fingerprint})}),
  testDingtalkBinding: (accountId:string) => request<DingTalkNotification>(`/api/v1/dingtalk/bindings/${encodeURIComponent(accountId)}/test`,{method:"POST"}),
  dingtalkProject: (productId:string) => request<DingTalkProjectSettings>(`/api/v1/products/${encodeURIComponent(productId)}/dingtalk`),
  saveDingtalkProject: (productId:string,enabled:boolean,expectedEnabled:boolean) => request<DingTalkProjectSettings>(`/api/v1/products/${encodeURIComponent(productId)}/dingtalk`,{method:"PUT",body:JSON.stringify({enabled,expectedEnabled})}),
  dingtalkNotifications: (itemKey:string) => request<{notifications:DingTalkNotification[];canRetry:boolean}>(`/api/v1/items/${encodeURIComponent(itemKey)}/dingtalk-notifications`),
  commentDingtalkNotifications: (itemKey:string,commentId:string) => request<{notifications:DingTalkNotification[];canRetry:boolean}>(`/api/v1/items/${encodeURIComponent(itemKey)}/comments/${encodeURIComponent(commentId)}/dingtalk-notifications`),
  retryDingtalkNotification: (itemKey:string,id:string) => request<{notifications:DingTalkNotification[];canRetry:boolean}>(`/api/v1/items/${encodeURIComponent(itemKey)}/dingtalk-notifications/${encodeURIComponent(id)}/retry`,{method:"POST"}),
  requestAgentArtifact: (sessionId: string, messageId: string, href: string) =>
    request<AgentArtifactState>(`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/artifacts`, { method: "POST", body: JSON.stringify({ messageId, href }) }),
  agentArtifact: (sessionId: string, id: string) =>
    request<AgentArtifactState>(`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(id)}`),
  agentArtifactBundle: (sessionId: string, id: string) =>
    request<AgentArtifactBundle>(`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(id)}/bundle`),
  insightBatches: () => request<{batches: InsightBatchSummary[]}>("/api/v1/project-insights/batches"),
  createInsightBatch: (name: string, itemKeys: string[]) => request<InsightBatch>("/api/v1/project-insights/batches", {method: "POST", body: JSON.stringify({name,itemKeys})}),
  insightBatchProgress: (id: string) => request<InsightBatchProgress>(`/api/v1/project-insights/batches/${encodeURIComponent(id)}`),
  deleteInsightBatch: (id: string) => requestNoContent(`/api/v1/project-insights/batches/${encodeURIComponent(id)}`, {method: "DELETE"}),

  projectInsights(input: InsightQuery & {productIds?: string[]}) {
    return request<InsightSummary>(`/api/v1/project-insights?${insightSearch(input)}`);
  },
  projectInsightItems(input: InsightQuery & {productIds?: string[]} & InsightDetailSelection) {
    return request<InsightDetails>(`/api/v1/project-insights/items?${insightSearch(input)}`);
  },
  statusChecks(productId: string, itemKey?: string, offset = 0) {
    return request<StatusCheckPage>(itemKey ? `/api/v1/items/${encodeURIComponent(itemKey)}/status-checks?offset=${offset}`
      : `/api/v1/products/${encodeURIComponent(productId)}/status-checks?offset=${offset}`);
  },
  requestStatusCheck(productId: string, itemKey?: string) {
    return request<StatusCheckPage>(itemKey ? `/api/v1/items/${encodeURIComponent(itemKey)}/status-checks`
      : `/api/v1/products/${encodeURIComponent(productId)}/status-checks`, {method:"POST"});
  },
  registerHandover(itemKey: string, input: {completion:CompletionReference;requiredArtifacts?:string[];noReleaseReason?:string}) {
    return request<{handover:StatusCheckRecord}>(`/api/v1/items/${encodeURIComponent(itemKey)}/handover`,{method:"PUT",body:JSON.stringify(input)});
  },
  confirmHandover(itemKey: string, handoverId: string, input: {stage:"integration";commit:string;note:string} | {stage:"release";note:string;releases:Array<{artifact:string;version:string;sourceCommit:string}>}) {
    return request<{handover:StatusCheckRecord}>(`/api/v1/items/${encodeURIComponent(itemKey)}/handovers/${encodeURIComponent(handoverId)}/confirm`, {method:"POST",body:JSON.stringify(input)});
  },
  getAiTitleSettings: () => request<{ configured: boolean; agentAttentionEnabled: boolean; model: string }>("/api/v1/ai/title-settings"),
  setAiTitleKey: (apiKey: string | null) => request<{ configured: boolean; agentAttentionEnabled: boolean; model: string }>("/api/v1/ai/title-settings", {
    method: "PUT", body: JSON.stringify({ apiKey }),
  }),
  setAgentAttentionEnabled: (agentAttentionEnabled: boolean) =>
    request<{ configured: boolean; agentAttentionEnabled: boolean; model: string }>("/api/v1/ai/title-settings", {
      method: "PUT", body: JSON.stringify({ agentAttentionEnabled }),
    }),
  generateTitle: (productId: string, content: string) => request<{ title: string }>("/api/v1/ai/title", {
    method: "POST", body: JSON.stringify({ productId, content }),
  }),
  getBootstrap: (productId: string | null, options: ListItemsOptions = {}) => {
    const query = new URLSearchParams();
    if (productId) query.set("productId", productId);
    appendItemFilters(query, options, true);
    if (options.builder) query.set("builder", options.builder);
    if (options.status) query.set("status", options.status);
    if (options.type) query.set("type", options.type);
    if (options.search) query.set("search", options.search);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return request<Bootstrap>(`/api/v1/bootstrap${suffix}`);
  },
  getSession: () => request<AuthSession>("/api/v1/auth/session"),
  getManagedDecision: (id: string) => request<ManagedDecisionView>(`/api/v1/managed-decisions/${encodeURIComponent(id)}`),
  approveManagedDecision: (id: string, input: ManagedDecisionGuard) => request<ManagedDecision>(`/api/v1/managed-decisions/${encodeURIComponent(id)}/approve`, {
    method: "POST", body: JSON.stringify(input),
  }),
  revokeManagedDecision: (id: string, input: ManagedDecisionGuard) => request<ManagedDecision>(`/api/v1/managed-decisions/${encodeURIComponent(id)}/revoke`, {
    method: "POST", body: JSON.stringify(input),
  }),
  login: (input: { username: string; password: string }) =>
    request<AuthSession>("/api/v1/auth/login", { method: "POST", body: JSON.stringify(input) }),
  logout: () => request<{ ok: true }>("/api/v1/auth/logout", { method: "POST" }),
  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    request<AuthSession>("/api/v1/auth/password", { method: "POST", body: JSON.stringify(input) }),
  changeEmail: (input: { currentPassword: string; email: string }) =>
    request<AuthSession>("/api/v1/auth/email", { method: "POST", body: JSON.stringify(input) }),
  // No password: a nickname is a label on your comments, not what signs you in.
  changeNickname: (nickname: string | null) =>
    request<AuthSession>("/api/v1/auth/nickname", { method: "POST", body: JSON.stringify({ nickname }) }),
  // No password either: the type size is a display preference, not a credential.
  changeFontScale: (fontScale: FontScale) =>
    request<AuthSession>("/api/v1/auth/font-scale", { method: "POST", body: JSON.stringify({ fontScale }) }),
  // The chat body's size is a second, independent preference (AND-254).
  changeConsoleFontScale: (consoleFontScale: FontScale) =>
    request<AuthSession>("/api/v1/auth/console-font-scale", { method: "POST", body: JSON.stringify({ consoleFontScale }) }),
  listAiAuthorizations: () =>
    request<{ authorizations: AiAuthorization[] }>("/api/v1/ai-authorizations"),
  revokeAiAuthorization: (authorizationId: string) =>
    requestNoContent(`/api/v1/ai-authorizations/${encodeURIComponent(authorizationId)}`, { method: "DELETE" }),
  // The plaintext comes back exactly once and is never stored server-side.
  createPersonalToken: (input: { name: string; scopes: string[]; days: number }) =>
    request<PersonalTokenCreated>("/api/v1/ai-personal-tokens", { method: "POST", body: JSON.stringify(input) }),
  listAccounts: () => request<{ accounts: Account[] }>("/api/v1/accounts"),
  listProjectAdministrators: (productId: string) => request<{accountIds:string[]}>(`/api/v1/products/${encodeURIComponent(productId)}/administrators`),
  setProjectAdministrators: (productId: string, accountIds: string[], expectedAccountIds: string[]) => request<{accountIds:string[]}>(`/api/v1/products/${encodeURIComponent(productId)}/administrators`, {method:"PUT",body:JSON.stringify({accountIds,expectedAccountIds})}),
  createAccount: (input: { email: string; password: string; role: AccountRole }) =>
    request<Account>("/api/v1/accounts", { method: "POST", body: JSON.stringify(input) }),
  updateAccount: (
    accountId: string,
    input: { email?: string; nickname?: string | null; role?: AccountRole; disabled?: boolean; password?: string },
  ) =>
    request<Account>(`/api/v1/accounts/${encodeURIComponent(accountId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteAccount: (accountId: string) =>
    request<void>(`/api/v1/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" }),
  listProductAccounts: (productId: string) =>
    request<{ accounts: ProductAccessEntry[] }>(`/api/v1/products/${encodeURIComponent(productId)}/accounts`),
  setProductAccounts: (
    productId: string,
    // An entry names its account by id, or by the address someone typed -- which
    // is how a product's creator adds a person without being able to list who
    // has an account here.
    accounts: Array<
      { accountId?: string; email?: string; canView: boolean; canOperate: boolean; canUseAi: boolean }
    >,
  ) =>
    request<{ accounts: ProductAccessEntry[] }>(`/api/v1/products/${encodeURIComponent(productId)}/accounts`, {
      method: "PUT",
      body: JSON.stringify({ accounts }),
    }),
  setAccountProducts: (accountId: string, permissions: ProductPermission[]) =>
    request<{ permissions: ProductPermission[] }>(`/api/v1/accounts/${encodeURIComponent(accountId)}/products`, {
      method: "PUT",
      body: JSON.stringify({ permissions }),
    }),
  listProducts: (options: { includeArchived?: boolean } = {}) =>
    request<Product[]>(`/api/v1/products${options.includeArchived ? "?includeArchived=true" : ""}`),
  createProduct: (input: { name: string; keyPrefix: string }) =>
    request<Product>("/api/v1/products", { method: "POST", body: JSON.stringify(input) }),
  updateProduct: (productId: string, input: { name?: string; archived?: boolean }) =>
    request<Product>(`/api/v1/products/${encodeURIComponent(productId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  setProductIcon: (productId: string, file: File) =>
    request<Product>(`/api/v1/products/${encodeURIComponent(productId)}/icon`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: file,
    }),
  removeProductIcon: (productId: string) =>
    request<Product>(`/api/v1/products/${encodeURIComponent(productId)}/icon`, { method: "DELETE" }),
  getItemFilterOptions: (productId: string) => request<{proposers: Array<{value: string; label: string; kind: "human" | "agent" | "sdk" | "unknown"}>}>(`/api/v1/products/${encodeURIComponent(productId)}/item-filter-options`),
  listBuilders: (productId: string) => request<{builders: Array<{id: string; name: string}>; canConfigure: boolean}>(`/api/v1/products/${encodeURIComponent(productId)}/builders`),
  setModuleBuilder: (productId: string, componentId: string, accountId: string | null) => request<Component>(`/api/v1/products/${encodeURIComponent(productId)}/components/${encodeURIComponent(componentId)}/builder`, {method:"PUT",body:JSON.stringify({accountId})}),
  getDelivery: (itemKey: string) => request<ItemDelivery>(`/api/v1/items/${encodeURIComponent(itemKey)}/delivery`),
  retryBuilderHandover: (itemKey: string, handoverId: string) => request<WorkItem>(`/api/v1/items/${encodeURIComponent(itemKey)}/builder-handover/${encodeURIComponent(handoverId)}/retry`, {method:"POST"}),
  transferBuilder: (itemKey: string, input: {accountId: string | null; expectedBuilderAccountId: string | null; note: string}) => request<WorkItem>(`/api/v1/items/${encodeURIComponent(itemKey)}/builder`, {method:"POST",body:JSON.stringify(input)}),
  assignExecution: (itemKey: string, input: {accountId?: string; kind?: "human" | "agent"; sessionId?: string; scope: string; previousId?: string; note?: string; followUp?: boolean}) => request(`/api/v1/items/${encodeURIComponent(itemKey)}/executions`, {method:"POST",body:JSON.stringify(input)}),
  updateExecution: (itemKey: string, executionId: string, status: string, result: string) => request(`/api/v1/items/${encodeURIComponent(itemKey)}/executions/${encodeURIComponent(executionId)}`, {method:"PATCH",body:JSON.stringify({status,result})}),
  listComponents: (productId: string, options: { includeArchived?: boolean } = {}) =>
    request<Component[]>(
      `/api/v1/products/${encodeURIComponent(productId)}/components${options.includeArchived ? "?includeArchived=true" : ""}`,
    ),
  createComponent: (productId: string, input: { name: string; kind: ComponentKind }) =>
    request<Component>(`/api/v1/products/${encodeURIComponent(productId)}/components`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateComponent: (productId: string, componentId: string, input: { name?: string; kind?: ComponentKind; archived?: boolean }) =>
    request<Component>(`/api/v1/products/${encodeURIComponent(productId)}/components/${encodeURIComponent(componentId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  listItems: (productId: string, options: ListItemsOptions = {}) => {
    const params = new URLSearchParams({ productId });
    appendItemFilters(params, options, true);
    if (options.builder) params.set("builder", options.builder);
    if (options.status) params.set("status", options.status);
    if (options.type) params.set("type", options.type);
    if (options.search?.trim()) params.set("search", options.search.trim());
    if (options.limit) params.set("limit", String(options.limit));
    if (options.beforeSequence) params.set("beforeSequence", String(options.beforeSequence));
    return request<WorkItemListPage>(`/api/v1/items?${params}`);
  },
  transferItem: (itemKey: string, targetProductId: string, idempotencyKey: string) =>
    request<WorkItem>(`/api/v1/items/${encodeURIComponent(itemKey)}/transfer`, {
      method: "POST", body: JSON.stringify({ targetProductId, idempotencyKey }),
    }),
  getItem: (itemKey: string) => request<WorkItem>(`/api/v1/items/${encodeURIComponent(itemKey)}`),
  createItem: (input: CreateWorkItemInput) =>
    request<WorkItem>("/api/v1/items", { method: "POST", body: JSON.stringify(input) }),
  updateItem: (itemKey: string, input: UpdateWorkItemInput) =>
    request<WorkItem>(`/api/v1/items/${encodeURIComponent(itemKey)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  uploadAttachment: async (itemKey: string, file: File, uploadId?: string, creationUploadId?: string) => {
    const response = await attachmentRequest(`/api/v1/items/${encodeURIComponent(itemKey)}/attachments`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-missiongo-content-type": file.type || "application/octet-stream",
        "x-missiongo-filename": encodeURIComponent(file.name),
        ...(uploadId ? { "x-missiongo-upload-id": uploadId } : {}),
        ...(creationUploadId ? { "x-missiongo-creation-upload-id": creationUploadId } : {}),
      },
      body: file,
    });
    return response.json() as Promise<WorkItemAttachment>;
  },
  // The SDK's diagnostics live in a .log attachment rather than in the item's
  // creation event, so the panel that renders them has to fetch the file.
  readTextAttachment: async (itemKey: string, attachmentId: string) => {
    const response = await attachmentRequest(
      `/api/v1/items/${encodeURIComponent(itemKey)}/attachments/${encodeURIComponent(attachmentId)}/content`,
      {},
    );
    return response.text();
  },
  downloadAttachment: async (itemKey: string, attachmentId: string, range?: { start: number; end?: number }) => {
    const response = await attachmentRequest(
      `/api/v1/items/${encodeURIComponent(itemKey)}/attachments/${encodeURIComponent(attachmentId)}/content`,
      range ? { headers: { range: `bytes=${range.start}-${range.end ?? ""}` } } : {},
    );
    return response.blob();
  },
  // List tiles and detail previews are a few hundred pixels at most; the
  // originals behind them run to megabytes. The server renders the small
  // version so neither a list nor a detail view pulls down full-resolution
  // screenshots nobody has opened yet.
  downloadAttachmentThumbnail: async (itemKey: string, attachmentId: string, width: number, revision: string) => {
    const response = await attachmentRequest(attachmentThumbnailPath(itemKey, attachmentId, width, revision), {});
    return response.blob();
  },
  // The whole image as something this browser can draw: the original, or for
  // HEIC a JPEG the server decoded from it. Opening and annotating use this;
  // downloading uses downloadAttachment and gets the original.
  downloadAttachmentPreview: async (itemKey: string, attachmentId: string, revision: string) => {
    const response = await attachmentRequest(attachmentPreviewPath(itemKey, attachmentId, revision), {});
    return response.blob();
  },
  // Annotating an image sends the result back over the same attachment, so the
  // number the detail view and the MCP item context cite stays put.
  replaceAttachment: async (itemKey: string, attachmentId: string, file: File) => {
    const response = await attachmentRequest(
      `/api/v1/items/${encodeURIComponent(itemKey)}/attachments/${encodeURIComponent(attachmentId)}/content`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-missiongo-content-type": file.type || "application/octet-stream",
          "x-missiongo-filename": encodeURIComponent(file.name),
        },
        body: file,
      },
    );
    return response.json() as Promise<WorkItemAttachment>;
  },

  deleteAttachment: async (itemKey: string, attachmentId: string) => {
    await attachmentRequest(`/api/v1/items/${encodeURIComponent(itemKey)}/attachments/${encodeURIComponent(attachmentId)}`, {
      method: "DELETE",
    });
  },
  // `note` is why the item is moving. The domain demands one on the ways back to
  // ready; everywhere else it is simply left out.
  /** Close verification on several items; each reports on its own (AND-66). */
  closeVerifications: (itemKeys: readonly string[]) =>
    request<{ results: BulkTransitionResult[] }>("/api/v1/items/transitions", {
      method: "POST",
      body: JSON.stringify({ itemKeys, to: "done", reason: "verification_passed" }),
    }),
  /** Return in-progress work to ready; the note is shared by the whole batch (AND-160). */
  releaseItems: (itemKeys: readonly string[], note: string) =>
    request<{ results: BulkTransitionResult[] }>("/api/v1/items/transitions", {
      method: "POST",
      body: JSON.stringify({ itemKeys, to: "ready", reason: "released", note }),
    }),
  transitionItem: (itemKey: string, action: TransitionAction, note?: string) =>
    request<WorkItem>(`/api/v1/items/${encodeURIComponent(itemKey)}/transitions`, {
      method: "POST",
      body: JSON.stringify({
        to: action.to,
        reason: action.reason,
        ...(note?.trim() ? { note: note.trim() } : {}),
      }),
    }),
  getTimeline: (itemKey: string) =>
    request<{ events: WorkItemEvent[] }>(`/api/v1/items/${encodeURIComponent(itemKey)}/timeline`),
  commentCandidates: (itemKey: string) => request<{candidates:CommentCandidate[]}>(`/api/v1/items/${encodeURIComponent(itemKey)}/comment-candidates`),
  createComment: (itemKey: string, input: CommentAudienceInput & { text: string; attachmentIds?: readonly string[]; idempotencyKey?: string }) =>
    request<WorkItemComment>(`/api/v1/items/${encodeURIComponent(itemKey)}/comments`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  withdrawComment: (itemKey: string, commentId: string) =>
    request<WorkItemComment>(
      `/api/v1/items/${encodeURIComponent(itemKey)}/comments/${encodeURIComponent(commentId)}/withdraw`,
      { method: "POST" },
    ),
  listSdkTokens: () => request<SdkToken[]>("/api/v1/sdk-tokens"),
  createSdkToken: (input: { name: string; productId: string; sourceComponentId?: string }) =>
    request<CreatedSdkToken>("/api/v1/sdk-tokens", { method: "POST", body: JSON.stringify(input) }),
  revokeSdkToken: (tokenId: string) =>
    request<SdkToken>(`/api/v1/sdk-tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" }),
  listNodes: () => request<{ nodes: DispatchNode[] }>("/api/v1/nodes"),
  connectExternalSession: (sessionId: string, nodeId: string) => request<AgentSession>(`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/native-connection`, { method: "PUT", body: JSON.stringify({ nodeId }) }),
  disconnectExternalSession: (sessionId: string) => request<AgentSession>(`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/native-connection`, { method: "DELETE" }),
  // Null clears it, so the machine goes back to its device name. The server
  // still reads `name` for pages loaded before nicknames, but this is the field.
  setNodeNickname: (nodeId: string, nickname: string | null) =>
    request<DispatchNode>(`/api/v1/nodes/${encodeURIComponent(nodeId)}`, {
      method: "PATCH",
      body: JSON.stringify({ nickname }),
    }),
  revokeNode: (nodeId: string) =>
    requestNoContent(`/api/v1/nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE" }),
  // The whole mapping table at once: the server replaces it wholesale, so a
  // removed row is a row left out rather than a second request.
  setNodeRepos: (nodeId: string, repos: readonly { productId: string; repoPath: string }[]) =>
    request<{ repos: NodeRepoMapping[] }>(`/api/v1/nodes/${encodeURIComponent(nodeId)}/repos`, {
      method: "PUT",
      body: JSON.stringify({ repos }),
    }),
  createDispatch: (input: CreateDispatchInput) =>
    request<Dispatch>("/api/v1/dispatches", { method: "POST", body: JSON.stringify(input) }),
  checkRedispatch: (itemKeys: readonly string[]) =>
    request<RedispatchEligibility>("/api/v1/dispatches/check", {method:"POST",body:JSON.stringify({itemKeys})}),
  // Ready items already sent to a machine and not yet claimed, so the list can
  // say so before somebody sends one again.
  listActiveDispatches: () => request<{ active: ActiveDispatch[]; latest: ItemDispatchSummary[]; current?: ItemDispatchSummary[]; handlers: ItemDispatchHandler[] }>("/api/v1/dispatches/active"),
  getDispatchHealth: (days = 7) => request<DispatchHealthSnapshot>(`/api/v1/dispatches/health?days=${days}`),
  listItemDispatches: (itemKey: string) =>
    request<{ dispatches: Dispatch[]; current?: ItemDispatchSummary }>(`/api/v1/items/${encodeURIComponent(itemKey)}/dispatches`),
  getAgentSession: (sessionId: string) =>
    request<AgentSession>(`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}`),
  decideAgentApproval: (sessionId: string, approvalId: string, decision: string) =>
    request(`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: "POST", body: JSON.stringify({ decision }),
    }),
  retryAgentApproval: (sessionId: string, approvalId: string) =>
    request(`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}/retry`, {
      method: "POST", body: JSON.stringify({}),
    }),
  listAgentSessions: (productId?: string) =>
    request<{ sessions: AgentSessionSummary[] }>(
      `/api/v1/agent-sessions${productId ? `?productId=${encodeURIComponent(productId)}` : ""}`,
    ),
  sendAgentSessionCommand: (sessionId: string, text: string, attachmentIds: readonly string[] = []) =>
    request<AgentSessionCommand>(`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/commands`, {
      method: "POST",
      body: JSON.stringify({ text, ...(attachmentIds.length ? { attachmentIds } : {}) }),
    }),
  approveAgentSessionPlan: (sessionId: string, revision: string) =>
    request<AgentSessionCommand>(`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/plan-approval`, {
      method: "POST", body: JSON.stringify({ revision }),
    }),
  uploadAgentSessionAttachment: async (sessionId: string, file: File) => {
    const response = await attachmentRequest(`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/attachments`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-missiongo-content-type": file.type || "application/octet-stream",
        "x-missiongo-filename": encodeURIComponent(file.name),
      },
      body: file,
    });
    return response.json() as Promise<AgentSessionAttachment>;
  },
  deleteAgentSessionAttachment: (sessionId: string, attachmentId: string) =>
    requestNoContent(`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`, {
      method: "DELETE",
    }),
  agentSessionAttachmentUrl: (sessionId: string, attachmentId: string) =>
    `/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/content`,
  agentSessionAttachmentPreviewUrl: (sessionId: string, attachmentId: string) =>
    `/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/preview`,
  setAgentSessionArchived: (sessionId: string, archived: boolean) =>
    request<AgentSession>(`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ archived }),
    }),
  dismissAgentSessionAttention: (sessionId: string, revision: string) =>
    request<AgentSession>(`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/attention/dismiss`, {
      method: "POST",
      body: JSON.stringify({ revision }),
    }),
  getDispatchDefaults: () => request<DispatchDefaults>("/api/v1/dispatch-defaults"),
  setDispatchDefaults: (defaults: DispatchDefaults) =>
    request<DispatchDefaults>("/api/v1/dispatch-defaults", { method: "PUT", body: JSON.stringify(defaults) }),
  setAgentSessionSettings: (sessionId: string, change: { mode?: string; model?: string; effort?: string }) =>
    request<AgentSessionSettings>(`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/settings`, {
      method: "PATCH",
      body: JSON.stringify(change),
    }),
  markAgentSessionRead: (sessionId: string, through: string) =>
    request<void>(`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/read`, { method: "POST", body: JSON.stringify({ through }) }),
  markDispatchRead: (dispatchId: string, through: string) =>
    request<void>(`/api/v1/dispatches/${encodeURIComponent(dispatchId)}/read`, {
      method: "POST",
      body: JSON.stringify({ through }),
    }),
  setDispatchArchived: (dispatchId: string, archived: boolean) =>
    request<Dispatch>(`/api/v1/dispatches/${encodeURIComponent(dispatchId)}/archive`, {
      method: "PATCH",
      body: JSON.stringify({ archived }),
    }),
  retryDispatch: (dispatchId: string) =>
    request<Dispatch>(`/api/v1/dispatches/${encodeURIComponent(dispatchId)}/retry`, { method: "POST" }),
  stopDispatch: (dispatchId: string) =>
    request<{ dispatch?: Dispatch; command?: AgentSessionCommand }>(
      `/api/v1/dispatches/${encodeURIComponent(dispatchId)}/stop`,
      { method: "POST" },
    ),
  cancelAgentSessionCommand: (sessionId: string, commandId: string) =>
    request<AgentSessionCommand>(
      `/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(commandId)}/cancel`,
      { method: "POST" },
    ),
  resolveAgentSessionDelivery: (sessionId: string, commandId: string, outcome: "received" | "not_received") =>
    request<AgentSessionCommand>(
      `/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(commandId)}/resolve-delivery`,
      { method: "POST", body: JSON.stringify({ outcome }) },
    ),
};

export interface ItemExecution {
  id: string; kind: "human" | "agent"; accountId: string; name: string; scope: string; previousId: string | null;
  sessionId?: string; recorded?: boolean; sessionStatus?: string; accountName?: string; status: string; result: string; createdAt: string; startedAt: string | null; endedAt: string | null;
}
export interface ItemDelivery {
  builderHandover?: WorkItem["builderHandover"]; canTakeOver?: boolean;
  builderAccountId: string | null; builderName: string | null; builderNeedsReassignment: boolean;
  canManage: boolean; canManageBuilder: boolean; currentAccountId: string; candidates: Array<{id: string; name: string}>;
  performers: Array<{id: string; name: string}>; executions: ItemExecution[];
}
