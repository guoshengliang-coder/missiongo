import { attachmentThumbnailPath } from "./attachment-thumbnail";
import type {
  ActiveDispatch,
  Component,
  CreatedSdkToken,
  CreateDispatchInput,
  SdkToken,
  ComponentKind,
  CreateWorkItemInput,
  Dispatch,
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

export interface ListItemsOptions {
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
}

/** One account's standing on one product, as the product-side editor shows it. */
export interface ProductAccessEntry {
  readonly account: Account;
  readonly permission: ProductPermission;
  /** True for an administrator, who reaches the product whatever the row says. */
  readonly reachesByRole: boolean;
}

export interface Account {
  readonly id: string;
  readonly email: string;
  readonly role: AccountRole;
  readonly disabledAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly permissions: ProductPermission[];
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
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

export const api = {
  getBootstrap: (productId: string | null, options: ListItemsOptions = {}) => {
    const query = new URLSearchParams();
    if (productId) query.set("productId", productId);
    if (options.status) query.set("status", options.status);
    if (options.type) query.set("type", options.type);
    if (options.search) query.set("search", options.search);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return request<Bootstrap>(`/api/v1/bootstrap${suffix}`);
  },
  getSession: () => request<AuthSession>("/api/v1/auth/session"),
  login: (input: { username: string; password: string }) =>
    request<AuthSession>("/api/v1/auth/login", { method: "POST", body: JSON.stringify(input) }),
  logout: () => request<{ ok: true }>("/api/v1/auth/logout", { method: "POST" }),
  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    request<AuthSession>("/api/v1/auth/password", { method: "POST", body: JSON.stringify(input) }),
  changeEmail: (input: { currentPassword: string; email: string }) =>
    request<AuthSession>("/api/v1/auth/email", { method: "POST", body: JSON.stringify(input) }),
  listAiAuthorizations: () =>
    request<{ authorizations: AiAuthorization[] }>("/api/v1/ai-authorizations"),
  revokeAiAuthorization: (authorizationId: string) =>
    request<void>(`/api/v1/ai-authorizations/${encodeURIComponent(authorizationId)}`, { method: "DELETE" }),
  listAccounts: () => request<{ accounts: Account[] }>("/api/v1/accounts"),
  createAccount: (input: { email: string; password: string; role: AccountRole }) =>
    request<Account>("/api/v1/accounts", { method: "POST", body: JSON.stringify(input) }),
  updateAccount: (accountId: string, input: { email?: string; role?: AccountRole; disabled?: boolean; password?: string }) =>
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
    accounts: Array<{ accountId: string; canView: boolean; canOperate: boolean; canUseAi: boolean }>,
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
    if (options.status) params.set("status", options.status);
    if (options.type) params.set("type", options.type);
    if (options.search?.trim()) params.set("search", options.search.trim());
    if (options.limit) params.set("limit", String(options.limit));
    if (options.beforeSequence) params.set("beforeSequence", String(options.beforeSequence));
    return request<WorkItemListPage>(`/api/v1/items?${params}`);
  },
  getItem: (itemKey: string) => request<WorkItem>(`/api/v1/items/${encodeURIComponent(itemKey)}`),
  createItem: (input: CreateWorkItemInput) =>
    request<WorkItem>("/api/v1/items", { method: "POST", body: JSON.stringify(input) }),
  updateItem: (itemKey: string, input: UpdateWorkItemInput) =>
    request<WorkItem>(`/api/v1/items/${encodeURIComponent(itemKey)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  uploadAttachment: async (itemKey: string, file: File) => {
    const response = await attachmentRequest(`/api/v1/items/${encodeURIComponent(itemKey)}/attachments`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-missiongo-content-type": file.type || "application/octet-stream",
        "x-missiongo-filename": encodeURIComponent(file.name),
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
  transitionItem: (itemKey: string, action: TransitionAction) =>
    request<WorkItem>(`/api/v1/items/${encodeURIComponent(itemKey)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ to: action.to, reason: action.reason }),
    }),
  getTimeline: (itemKey: string) =>
    request<{ events: WorkItemEvent[] }>(`/api/v1/items/${encodeURIComponent(itemKey)}/timeline`),
  createComment: (itemKey: string, input: { text: string }) =>
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
  // Ready items already sent to a machine and not yet claimed, so the list can
  // say so before somebody sends one again.
  listActiveDispatches: () => request<{ active: ActiveDispatch[] }>("/api/v1/dispatches/active"),
  listItemDispatches: (itemKey: string) =>
    request<{ dispatches: Dispatch[] }>(`/api/v1/items/${encodeURIComponent(itemKey)}/dispatches`),
};
