import type {
  Component,
  CreatedSdkToken,
  SdkToken,
  ComponentKind,
  CreateWorkItemInput,
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

export interface AuthenticatedUser {
  readonly id: string;
  readonly username: string;
  readonly role: "admin";
}

export interface AuthSession {
  readonly user: AuthenticatedUser;
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
};
