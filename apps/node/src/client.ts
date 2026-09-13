import { normalizeServerUrl } from "./config.js";
import type { RepoCandidate } from "./repo-candidates.js";
import type { AgentKind } from "./agents/types.js";

/**
 * The node side of the dispatch protocol.
 *
 * Everything is an outbound POST: the machine opens no port and accepts no
 * connection, so a developer machine never becomes reachable from the network
 * just because it can run dispatches.
 */

const REQUEST_TIMEOUT_MS = 15_000;

export type FetchLike = typeof fetch;

export type DetectedAgent = { kind: AgentKind; version: string };
export type RepoMapping = { productKey: string; productId: string; repoPath: string };
export type PairedNode = { nodeId: string; name: string; token: string };

export type DispatchRequest = {
  dispatchId: string;
  itemKeys: string[];
  repoPath: string;
  agentKind: AgentKind;
  mode: string;
};

export type DispatchReport = {
  status: "launched" | "failed";
  sessionName?: string;
  sessionUrl?: string;
  error?: string;
};

/**
 * The token is gone for good: revoked, or the node was deleted. Unlike a
 * network blip this never fixes itself, so the loop stops instead of hammering
 * the server with a credential that will keep being refused.
 */
export class NodeAuthError extends Error {}

function assertObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error(`${what} 返回了意外的响应体。`);
  return value as Record<string, unknown>;
}

function assertString(record: Record<string, unknown>, field: string, what: string): string {
  const value = record[field];
  if (typeof value !== "string" || value === "") throw new Error(`${what} 的响应缺少字段 ${field}。`);
  return value;
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  body: unknown,
  token?: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, text: await response.text() };
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Pairing is the one call without a token: the pairing code stands in for it. */
export async function pairNode(input: {
  serverUrl: string;
  code: string;
  hostname: string;
  fetchImpl?: FetchLike;
}): Promise<PairedNode> {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const { status, text } = await postJson(
    input.fetchImpl ?? fetch,
    `${serverUrl}/api/v1/node/pair`,
    { code: input.code, hostname: input.hostname },
  );
  // Any 2xx counts. Pairing answers 201, and insisting on 200 turned a
  // successful pairing into a reported failure while the credential was already
  // spent — the code is single use, so the retry could only fail too.
  if (!isSuccess(status)) throw new Error(`配对失败（HTTP ${status}）：${text || "无响应内容"}`);
  const record = assertObject(JSON.parse(text), "配对");
  return {
    nodeId: assertString(record, "nodeId", "配对"),
    name: assertString(record, "name", "配对"),
    token: assertString(record, "token", "配对"),
  };
}

export class NodeApiClient {
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: { serverUrl: string; token: string; fetchImpl?: FetchLike }) {
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async post(
    path: string,
    body: unknown,
    timeoutMs?: number,
  ): Promise<{ status: number; text: string }> {
    const result = await postJson(this.fetchImpl, `${this.serverUrl}${path}`, body, this.token, timeoutMs);
    if (result.status === 401 || result.status === 403) {
      throw new NodeAuthError(`机器凭证已失效（HTTP ${result.status}）：需要重新配对。`);
    }
    return result;
  }

  async heartbeat(
    agents: readonly DetectedAgent[],
    repoCandidates: readonly RepoCandidate[] = [],
  ): Promise<{ repos: RepoMapping[] }> {
    const { status, text } = await this.post("/api/v1/node/heartbeat", { agents, repoCandidates });
    if (!isSuccess(status)) throw new Error(`heartbeat 失败（HTTP ${status}）：${text || "无响应内容"}`);
    const record = assertObject(JSON.parse(text), "heartbeat");
    const repos = Array.isArray(record.repos) ? (record.repos as RepoMapping[]) : [];
    return { repos };
  }

  /** `undefined` when the server answers 204: nothing queued for this machine. */
  /**
   * Long poll: `waitMs` asks the server to hold the request open until there is
   * work. It answers 204 when the wait runs out, which is an idle poll, not an
   * error — the loop simply asks again.
   */
  async claimNext(waitMs = 0): Promise<DispatchRequest | undefined> {
    // The client timeout has to outlast the wait the server was asked for, or
    // every long poll would abort locally just before the server answers.
    const { status, text } = await this.post(
      "/api/v1/node/dispatches/claim-next",
      { waitMs },
      waitMs > 0 ? waitMs + REQUEST_TIMEOUT_MS : undefined,
    );
    if (status === 204) return undefined;
    if (!isSuccess(status)) throw new Error(`claim-next 失败（HTTP ${status}）：${text || "无响应内容"}`);
    const record = assertObject(JSON.parse(text), "claim-next");
    const itemKeys = record.itemKeys;
    if (!Array.isArray(itemKeys) || itemKeys.some((key) => typeof key !== "string")) {
      throw new Error("claim-next 的响应里 itemKeys 不是字符串数组。");
    }
    return {
      dispatchId: assertString(record, "dispatchId", "claim-next"),
      itemKeys: itemKeys as string[],
      repoPath: assertString(record, "repoPath", "claim-next"),
      agentKind: assertString(record, "agentKind", "claim-next") as AgentKind,
      mode: assertString(record, "mode", "claim-next"),
    };
  }

  async reportResult(dispatchId: string, report: DispatchReport): Promise<void> {
    const path = `/api/v1/node/dispatches/${encodeURIComponent(dispatchId)}/result`;
    const { status, text } = await this.post(path, report);
    // The server answers 204 here; the same 200-only check would have made every
    // launch look like a failed hand-off and put the daemon into a retry loop.
    if (!isSuccess(status)) throw new Error(`回报结果失败（HTTP ${status}）：${text || "无响应内容"}`);
  }
}
