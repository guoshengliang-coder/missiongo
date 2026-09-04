import type {
  CreateWorkItemInput,
  Product,
  TransitionAction,
  UpdateWorkItemInput,
  WorkItem,
  WorkItemAttachment,
  WorkItemEvent,
  WorkItemStatus,
  WorkItemType,
} from "./types";

const TOKEN_KEY = "missiongo.admin-token";

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

export function getAdminToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

export function setAdminToken(token: string): void {
  if (token.trim()) sessionStorage.setItem(TOKEN_KEY, token.trim());
  else sessionStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAdminToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  const token = getAdminToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { code?: string; title?: string } | null;
    throw new ApiError(response.status, problem?.code ?? "request_failed", problem?.title ?? "Request failed.");
  }
  return response;
}

export const api = {
  listProducts: () => request<Product[]>("/api/v1/products"),
  createProduct: (input: { name: string; keyPrefix: string }) =>
    request<Product>("/api/v1/products", { method: "POST", body: JSON.stringify(input) }),
  listItems: (productId: string, status?: WorkItemStatus, type?: WorkItemType) => {
    const params = new URLSearchParams({ productId });
    if (status) params.set("status", status);
    if (type) params.set("type", type);
    return request<{ items: WorkItem[] }>(`/api/v1/items?${params}`);
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
  downloadAttachment: async (itemKey: string, attachmentId: string) => {
    const response = await attachmentRequest(
      `/api/v1/items/${encodeURIComponent(itemKey)}/attachments/${encodeURIComponent(attachmentId)}/content`,
    );
    return response.blob();
  },
  transitionItem: (itemKey: string, action: TransitionAction) =>
    request<WorkItem>(`/api/v1/items/${encodeURIComponent(itemKey)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ to: action.to, reason: action.reason }),
    }),
  getTimeline: (itemKey: string) =>
    request<{ events: WorkItemEvent[] }>(`/api/v1/items/${encodeURIComponent(itemKey)}/timeline`),
};
