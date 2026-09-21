import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";

import {
  formatFeedbackLog,
  TRANSITION_REASONS,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
  type AgentKind,
  type WorkItemCreator,
  type WorkItemEnvironment,
  type WorkItemReport,
} from "@missiongo/domain";

import {
  ADMIN_SESSION_COOKIE,
  adminSessionCookie,
  createAdminSession,
  expiredAdminSessionCookie,
  readAiAccessToken,
  readAdminSession,
  type AdminAccountConfig,
  type AdminSessionUser,
} from "./admin-auth.js";
import sharp from "sharp";

import {
  AccountStore,
  accountDisplayName,
  normalizeEmail,
  type AccountSnapshot,
  type ProductCapability,
  type ProductPermission,
} from "./accounts-store.js";
import { AttachmentStorage, MAX_ATTACHMENT_BYTES } from "./attachment-storage.js";
import { AiTitleService } from "./ai-title.js";
import { AgentSessionStore, type AgentMessageRole, type AgentSessionStatus } from "./agent-session-store.js";
import { DispatchStore } from "./dispatch-store.js";
import { conflict, invalidInput, MissionGoError, notFound } from "./errors.js";
import { createMissionGoMcpHandler, type McpWriteTier } from "./mcp.js";
import {
  MISSIONGO_READ_SCOPE,
  MISSIONGO_SUPPORTED_SCOPES,
  MISSIONGO_NODE_SCOPE,
  MISSIONGO_WRITE_SCOPE,
  MissionGoOAuthProvider,
  type OAuthAuthorizationInput,
} from "./oauth.js";
import { MissionGoStore } from "./store.js";
import { COMMENT_BODY_KINDS, COMPONENT_KINDS, type ComponentKind } from "./types.js";
import type { FeedbackLogEntry, SdkPrincipal } from "./types.js";

export interface BuildAppOptions {
  readonly databasePath?: string;
  readonly logger?: FastifyServerOptions["logger"];
  readonly adminToken?: string;
  readonly adminAccount?: AdminAccountConfig;
  readonly publicOrigin?: string;
  readonly attachmentsPath?: string;
  /** Fastify trust-proxy setting: false, true, or trusted addresses/CIDRs/named ranges. */
  readonly trustProxy?: boolean | string;
  readonly sdkRateLimits?: Partial<Readonly<Record<SdkRateLimitBucket, SdkRateLimitRule>>>;
  /** How much of the MCP write surface to expose. Defaults to none. */
  readonly writeTools?: McpWriteTier;
  /** Commit this build came from, reported by /health so a deployment can name itself. */
  readonly release?: string;
  /** Replaced only by tests; production sends requests directly to DeepSeek. */
  readonly aiProviderFetch?: typeof fetch;
}

type SdkRateLimitBucket = "draft_read" | "draft_write" | "finalize" | "web_session" | "attachment_upload" | "ai_title";
interface SdkRateLimitRule {
  readonly limit: number;
  readonly windowMilliseconds: number;
}

const DEFAULT_SDK_RATE_LIMITS: Readonly<Record<SdkRateLimitBucket, SdkRateLimitRule>> = {
  draft_read: { limit: 120, windowMilliseconds: 60_000 },
  draft_write: { limit: 60, windowMilliseconds: 60_000 },
  finalize: { limit: 20, windowMilliseconds: 60 * 60_000 },
  web_session: { limit: 60, windowMilliseconds: 60 * 60_000 },
  attachment_upload: { limit: 60, windowMilliseconds: 60 * 60_000 },
  ai_title: { limit: 60, windowMilliseconds: 60_000 },
};

/** Square edge of a stored product icon, in pixels. Small enough to live in the row. */
const PRODUCT_ICON_EDGE = 96;

/** Two rows of 84px tiles at 2x, which covers every list layout we render. */
const DEFAULT_THUMBNAIL_EDGE = 192;
/** The detail view's preview cards run to a few hundred CSS pixels, drawn at 2x. */
const MAX_THUMBNAIL_EDGE = 1024;

const ENVIRONMENT_PLATFORMS = ["android", "macos", "web", "server", "shared", "other"] as const;

function sequenceFromItemKey(itemKey: string | undefined): number | undefined {
  const match = itemKey?.match(/-(\d+)$/);
  if (!match) return undefined;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : undefined;
}

function requestedByteRange(value: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) return undefined;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    return undefined;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function booleanField(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (typeof value !== "boolean") throw invalidInput(`${field} must be true or false.`);
  return value;
}

/**
 * How long a node may ask the server to hold its poll open. Comfortably inside
 * the reverse proxy's 300s read timeout, so the wait ends here rather than as a
 * dropped connection the daemon has to interpret.
 */
const MAX_CLAIM_WAIT_MS = 25_000;
/**
 * How many rows one product-access save may carry.
 *
 * The editor sends one per account on screen, so this is only ever hit by a
 * hand-made request; without it a member creator could ask for tens of thousands
 * of account lookups inside a single transaction.
 */
const MAX_PRODUCT_ACCESS_ENTRIES = 200;

/**
 * A machine's nickname from a request body: a string sets it, empty or null
 * clears it. `name` is still read, because a console page loaded before this
 * change sends the rename that way until it refreshes onto the new build.
 */
function nicknameField(body: Record<string, unknown>): string | null {
  const value = body.nickname !== undefined ? body.nickname : body.name;
  if (value === null) return null;
  if (typeof value !== "string") throw invalidInput("nickname must be a string or null.");
  return value;
}

/**
 * A field that may be absent, explicitly null, or a string.
 *
 * stringField cannot say which: for a nickname, "not in this request" and "clear
 * it" are different instructions and only one of them writes to the row.
 */
function nullableStringField(body: Record<string, unknown>, field: string): string | null | undefined {
  if (body[field] === undefined) return undefined;
  if (body[field] === null) return null;
  if (typeof body[field] !== "string") throw invalidInput(`${field} must be a string or null.`);
  return body[field] as string;
}

/** For requests whose body is optional, unlike the ones objectBody guards. */
function objectBodyOrEmpty(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput("A JSON object is required.");
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string, required = true): string | undefined {
  const value = body[field];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw invalidInput(`${field} must be a string.`);
  return value;
}

/** How many items one bulk transition may move (AND-66). */
const BULK_TRANSITION_LIMIT = 50;

function stringArrayField(body: Record<string, unknown>, field: string): readonly string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalidInput(`${field} must be an array of strings.`);
  }
  return value as string[];
}

function stringMapField(body: Record<string, unknown>, field: string): Readonly<Record<string, string>> {
  const value = body[field];
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidInput(`${field} must be an object of string values.`);
  }
  if (Object.values(value).some((entry) => typeof entry !== "string")) {
    throw invalidInput(`${field} must be an object of string values.`);
  }
  return value as Readonly<Record<string, string>>;
}

function feedbackLogsField(body: Record<string, unknown>): readonly FeedbackLogEntry[] {
  const value = body.logs;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidInput("logs must be an array.");
  return value.map((entry) => {
    const log = objectBody(entry);
    return {
      timestamp: stringField(log, "timestamp")!,
      level: enumField(log, "level", ["debug", "info", "warn", "error"] as const)!,
      message: stringField(log, "message")!,
      ...(log.attributes !== undefined ? { attributes: stringMapField(log, "attributes") } : {}),
    };
  });
}

function workItemReportBody(value: unknown): WorkItemReport | undefined {
  if (value === undefined) return undefined;
  const body = objectBody(value);
  return {
    overview: stringField(body, "overview")!,
    ...(stringField(body, "reproductionSteps", false) !== undefined
      ? { reproductionSteps: body.reproductionSteps as string }
      : {}),
    ...(stringField(body, "expectedOutcome", false) !== undefined
      ? { expectedOutcome: body.expectedOutcome as string }
      : {}),
    ...(stringField(body, "impact", false) !== undefined ? { impact: body.impact as string } : {}),
    ...(body.occurrenceFrequency !== undefined
      ? { occurrenceFrequency: enumField(body, "occurrenceFrequency", ["unknown", "once", "intermittent", "frequent", "always"] as const)! }
      : {}),
  };
}

function enumField<T extends string>(
  body: Record<string, unknown>,
  field: string,
  choices: readonly T[],
  required = true,
): T | undefined {
  const value = body[field];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw invalidInput(`${field} must be one of: ${choices.join(", ")}.`);
  }
  return value as T;
}

function environmentBody(value: unknown, allowNull = false): WorkItemEnvironment | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && allowNull) return null;
  const body = objectBody(value);
  const platform = enumField(body, "platform", ENVIRONMENT_PLATFORMS)!;
  const optionalText = (field: string): string | undefined => {
    const result = stringField(body, field, false)?.trim();
    if (result && result.length > 500) throw invalidInput(`${field} must be 500 characters or fewer.`);
    return result || undefined;
  };

  const metadataValue = body.metadata;
  let metadata: Readonly<Record<string, string>> | undefined;
  if (metadataValue !== undefined) {
    if (!metadataValue || typeof metadataValue !== "object" || Array.isArray(metadataValue)) {
      throw invalidInput("environment.metadata must be an object of string values.");
    }
    const entries = Object.entries(metadataValue);
    if (entries.length > 50 || entries.some(([key, entry]) => !key.trim() || key.length > 100 || typeof entry !== "string" || entry.length > 2_000)) {
      throw invalidInput("environment.metadata contains an invalid key or value.");
    }
    metadata = Object.fromEntries(entries);
  }

  const appVersion = optionalText("appVersion");
  const buildNumber = optionalText("buildNumber");
  const sourceRevision = optionalText("sourceRevision");
  const osVersion = optionalText("osVersion");
  const deviceModel = optionalText("deviceModel");
  return {
    platform,
    ...(appVersion ? { appVersion } : {}),
    ...(buildNumber ? { buildNumber } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(osVersion ? { osVersion } : {}),
    ...(deviceModel ? { deviceModel } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function headerText(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalidInput(`${name} header is required.`);
  return value.trim();
}

function publicAttachment<T extends { readonly storageFilename: string }>(attachment: T): Omit<T, "storageFilename"> {
  const { storageFilename: _, ...visible } = attachment;
  return visible;
}

function hasBearerToken(authorization: string | undefined, token: string): boolean {
  const suppliedToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expected = Buffer.from(token);
  const supplied = Buffer.from(suppliedToken);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function suppliedBearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function cookieValue(request: FastifyRequest, name: string): string {
  const cookies = request.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function singleQueryValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function escapedHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

/**
 * The consent screen has to describe what this deployment will actually let the
 * client do, which is the granted scope *and* the write tier together. Naming a
 * capability the tier does not expose asks for permission on false terms, and
 * this is the one screen where that matters most.
 */
function oauthLoginPage(
  clientName: string,
  requestToken: string,
  scopes: readonly string[],
  writeTools: McpWriteTier,
  invalidCredentials = false,
): string {
  const writes = scopes.includes(MISSIONGO_WRITE_SCOPE) && writeTools !== "none";
  const writeGrant = "<strong>发表评论、把待处理的任务领为处理中、并在 PR 合并后推到待验证</strong>。"
    + "只有这两个状态变更——验收、退回、搁置，以及做不了怎么办，都由你决定。"
    + "<strong>在你于会话里确认内容后，从正在处理的条目拆出衍生条目</strong>。"
    + "它不能修改你写的内容，不能删除条目，不能撤回评论。";
  const nodeGrant = "<strong>把这台 Mac 登记为你的设备</strong>：接收你在控制台派出的任务，并在本机启动 agent 会话处理。"
    + "随时可以在控制台「Agent 管理」里撤销。";
  const scopeNote = scopes.includes(MISSIONGO_WRITE_SCOPE) && writeTools === "none"
    ? "本次只会签发读取授权：这个部署当前没有开放 AI 写入。"
    : writes
      ? "服务端会签发限时读写授权，并在每次请求时校验账号权限。"
      : "服务端会签发限时读取授权，并在每次读取时校验账号权限。";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>连接 MissionGo</title>
  <link rel="stylesheet" href="/oauth/login.css">
</head>
<body><main class="card">
  <div class="mark">🚀</div><p class="eyebrow">${writes ? "AI 读写授权" : "AI 读取授权"}</p><h1 class="title">连接 MissionGo</h1>
  <p class="copy"><span class="client">${escapedHtml(clientName)}</span> 请求以下权限。首次连接请验证账号。授权后它读到的范围，就是你这个账号的产品权限。</p>
  <ul class="scopes">
    <li>读取你有权限查看的 MissionGo 内容</li>
    ${writes ? `<li>${writeGrant}</li>` : ""}
    ${scopes.includes(MISSIONGO_NODE_SCOPE) ? `<li>${nodeGrant}</li>` : ""}
  </ul>
  ${invalidCredentials ? '<p class="error">邮箱或密码不正确，请重新输入。</p>' : ""}
  <form method="post" action="/oauth/authorize">
    <input type="hidden" name="request" value="${escapedHtml(requestToken)}">
    <label for="username">邮箱</label><input id="username" name="username" type="email" autocomplete="username" required autofocus>
    <label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">确认并连接</button>
  </form>
  <p class="note">密码只用于本次验证，不会交给 AI。${scopeNote}</p>
</main></body></html>`;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, trustProxy: options.trustProxy ?? false });
  const store = new MissionGoStore(options.databasePath ?? ":memory:");
  const dispatchStore = new DispatchStore(store.database);
  const agentSessionStore = new AgentSessionStore(store.database);
  const accountStore = new AccountStore(store.database);
  const aiTitle = new AiTitleService(
    store.database,
    options.adminAccount?.sessionSecret ?? options.adminToken ?? "local-development-only",
    options.aiProviderFetch,
  );
  if (options.adminAccount) {
    accountStore.seedBootstrapAdmin({
      id: options.adminAccount.id,
      email: options.adminAccount.username,
      passwordScrypt: options.adminAccount.passwordScrypt,
      ...(options.adminAccount.authorizedProductIds
        ? { authorizedProductIds: options.adminAccount.authorizedProductIds }
        : {}),
    });
  }
  const attachmentStorage = new AttachmentStorage(options.attachmentsPath ?? "./data/attachments");
  const publicOrigin = new URL(options.publicOrigin ?? "http://127.0.0.1").origin;
  const writeTools: McpWriteTier = options.writeTools ?? "none";
  const mcpHandler = options.adminAccount
    // Only hand out an update URL when a real deployment origin was configured;
    // the loopback fallback above is not an address a client can reinstall from.
    ? createMissionGoMcpHandler(store, attachmentStorage, {
      ...(options.publicOrigin ? { publicOrigin } : {}),
      ...(options.writeTools ? { writeTools: options.writeTools } : {}),
    })
    : undefined;
  const oauthProvider = options.adminAccount ? new MissionGoOAuthProvider(options.adminAccount, publicOrigin) : undefined;
  const sdkRateLimits = { ...DEFAULT_SDK_RATE_LIMITS, ...options.sdkRateLimits };
  const loginFailures = new Map<string, { count: number; resetAt: number }>();

  const loginIsRateLimited = (request: FastifyRequest, reply: FastifyReply, now: number): boolean => {
    const failure = loginFailures.get(request.ip);
    if (failure && failure.resetAt <= now) loginFailures.delete(request.ip);
    if (!failure || failure.resetAt <= now || failure.count < 10) return false;
    reply.header("retry-after", Math.ceil((failure.resetAt - now) / 1_000)).status(429).send({
      type: "urn:missiongo:problem:login_rate_limited",
      title: "Too many sign-in attempts. Try again later.",
      status: 429,
      code: "login_rate_limited",
    });
    return true;
  };

  const recordLoginFailure = (request: FastifyRequest, now: number): void => {
    const current = loginFailures.get(request.ip);
    loginFailures.set(request.ip, {
      count: (current?.resetAt ?? 0) > now ? current!.count + 1 : 1,
      resetAt: (current?.resetAt ?? 0) > now ? current!.resetAt : now + 15 * 60_000,
    });
  };

  /**
   * The account behind the request's session cookie, or nothing.
   *
   * Two steps, and both matter. The signature says the server minted this
   * cookie; the accounts table says the account still exists, is still enabled,
   * and has not changed its password since -- which is what stands in for a
   * sessions table. A cookie that passes the first check and fails the second is
   * exactly the case this exists for.
   */
  const sessionAccount = (request: FastifyRequest): AccountSnapshot | undefined => {
    if (!options.adminAccount) return undefined;
    const claims = readAdminSession(options.adminAccount, cookieValue(request, ADMIN_SESSION_COOKIE));
    if (!claims) return undefined;
    return accountStore.resolveActive(claims.id, claims.credentialsAt);
  };

  const sessionUser = (request: FastifyRequest): AdminSessionUser | undefined => {
    const account = sessionAccount(request);
    return account ? { id: account.id, username: account.email, role: account.role } : undefined;
  };

  /**
   * An account as the console reads it.
   *
   * Kept apart from AdminSessionUser above, which is a signing payload: whatever
   * goes in there is frozen into a cookie and into AI tokens that live for a
   * month. A display name changes whenever its owner feels like it, so it is
   * resolved per response instead, and `username` stays the address people sign
   * in with -- the login form posts it back under that name.
   */
  const authenticatedUser = (account: AccountSnapshot) => ({
    id: account.id,
    username: account.email,
    displayName: accountDisplayName(account),
    // The raw value, so the settings field can start empty rather than
    // pre-filled with the fallback, which a single Save would then make real.
    ...(account.nickname ? { nickname: account.nickname } : {}),
    role: account.role,
  });

  const sessionUserResponse = (request: FastifyRequest) => {
    const account = sessionAccount(request);
    return account ? authenticatedUser(account) : undefined;
  };

  /**
   * Whether this request is exempt from per-product authorization.
   *
   * Two cases, both of which already bypass the sign-in hook below. A deployment
   * with neither an account nor an operator token is a local run with no sign-in
   * at all, so there is no account to check permissions for. A request carrying
   * the operator token is a machine, not a person: the token names no account,
   * which is exactly why docs/security-boundaries.md records it as reaching
   * every product.
   */
  const unauthenticatedDeployment = !options.adminAccount && !options.adminToken;

  const bearerAuthorized = (request: FastifyRequest): boolean =>
    unauthenticatedDeployment
    || (options.adminToken ? hasBearerToken(request.headers.authorization, options.adminToken) : false);

  /**
   * The account behind an AI bearer token, with the products it currently
   * reaches.
   *
   * The reach is read here rather than taken from the token, so unticking a
   * product in the console applies to authorizations already in the wild.
   */
  const aiPrincipal = (token: string) => {
    if (!options.adminAccount) return undefined;
    const claims = readAiAccessToken(options.adminAccount, token);
    if (!claims) return undefined;
    const account = accountStore.resolveActive(claims.id, claims.credentialsAt);
    if (!account) return undefined;
    // Cut off on its own, without touching the account's other clients. A token
    // with no record predates the table and is not refused by this -- see
    // ai_authorizations in the schema.
    if (accountStore.aiAuthorizationRevoked(claims.tokenId)) return undefined;
    accountStore.touchAiAuthorization(claims.tokenId);
    return {
      ...claims,
      username: account.email,
      displayName: accountDisplayName(account),
      role: account.role,
      productIds: accountStore.reachableProductIds(account, "ai"),
    };
  };

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_ATTACHMENT_BYTES },
    (_request, body, done) => done(null, body),
  );
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 16 * 1024 },
    (_request, body, done) => done(null, body),
  );

  app.decorate("missionGoStore", store);
  app.decorate("missionGoAccounts", accountStore);
  app.addHook("onClose", async () => {
    await mcpHandler?.close();
    store.close();
  });

  // Baseline security headers, so they survive swapping the reverse proxy. CSP
  // and HSTS deliberately stay in the TLS-terminating proxy: the app never sees
  // TLS, and a second CSP header would be intersected with the proxy's, which
  // would drop the form-action relaxation the OAuth callback needs.
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
  });

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0]!;
    if (
      !path.startsWith("/api/v1/")
      || path.startsWith("/api/v1/sdk/")
      || path === "/api/v1/auth/login"
      || path === "/api/v1/auth/session"
      || path === "/api/v1/auth/logout"
      // Answers its own 401, exactly as /auth/session does, because the console
      // reads that status to decide whether to draw the sign-in page. Letting the
      // hook answer instead would drop the `no-store` the reply needs, and would
      // admit a bearer-token caller the handler then has no session to serve.
      || path === "/api/v1/bootstrap"
      // A node presents its own credential, exactly as the SDK does, and has no
      // admin session to offer.
      || path.startsWith("/api/v1/node/")
      || (!options.adminToken && !options.adminAccount)
    ) return;
    // This hook only answers "is anyone here". Which products that someone may
    // reach is decided per route, by requireProductPermission below: a single
    // gate that lets every signed-in account at every route is what AND-33 is
    // fixing.
    if (!bearerAuthorized(request) && !sessionUser(request)) {
      return reply.status(401).send({
        type: "urn:missiongo:problem:authentication_required",
        title: "A valid bearer token is required.",
        status: 401,
        code: "authentication_required",
      });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof MissionGoError) {
      return reply.status(error.statusCode).send({
        type: `urn:missiongo:problem:${error.code}`,
        title: error.message,
        status: error.statusCode,
        code: error.code,
      });
    }

    app.log.error(error);
    return reply.status(500).send({
      type: "urn:missiongo:problem:internal_error",
      title: "An unexpected error occurred.",
      status: 500,
      code: "internal_error",
    });
  });

  // A running deployment has to be able to say which commit it is. The only
  // record used to be a timestamped directory name on the host, so "what is
  // live right now" could not be answered without guessing.
  app.get("/health", async () => ({ status: "ok", release: options.release ?? "unknown" }));

  if (oauthProvider && options.adminAccount) {
    app.get("/oauth/login.css", async (_request, reply) => reply
      .header("cache-control", "public, max-age=3600")
      .type("text/css; charset=utf-8")
      .send(`*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f3ed;color:#172033;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;padding:20px}.card{width:min(100%,440px);background:#fff;border:1px solid #dedbd2;border-radius:24px;padding:32px;box-shadow:0 20px 55px rgba(23,32,51,.12)}.mark{display:grid;place-items:center;width:54px;height:54px;border-radius:17px;background:#61dfb3;font-size:27px}.eyebrow{margin:24px 0 8px;color:#72798a;font-size:13px;font-weight:700}.title{margin:0;font-size:30px;line-height:1.15}.copy{color:#697183;line-height:1.65}.scopes{margin:0 0 4px;padding-left:20px;color:#697183;line-height:1.7;font-size:14px}.scopes strong{color:#172033}.client{font-weight:700;color:#172033}.error{padding:11px 13px;border-radius:12px;background:#fff0f0;color:#ad2e2e;font-size:14px}label{display:block;margin:18px 0 7px;font-size:14px;font-weight:700}input{width:100%;height:48px;border:1px solid #cbc8c0;border-radius:12px;padding:0 13px;font:inherit}button{width:100%;height:50px;margin-top:24px;border:0;border-radius:13px;background:#172033;color:#fff;font:inherit;font-weight:750;cursor:pointer}.note{margin:16px 0 0;color:#7a8190;font-size:12px;line-height:1.55}@media(max-width:520px){.card{padding:24px;border-radius:20px}.title{font-size:27px}}`));

    app.get("/.well-known/oauth-protected-resource/mcp", async (_request, reply) => reply
      .header("cache-control", "public, max-age=300")
      .send({
        resource: `${publicOrigin}/mcp`,
        authorization_servers: [publicOrigin],
        scopes_supported: [...MISSIONGO_SUPPORTED_SCOPES],
        bearer_methods_supported: ["header"],
      }));

    app.get("/.well-known/oauth-authorization-server", async (_request, reply) => reply
      .header("cache-control", "public, max-age=300")
      .send({
        issuer: publicOrigin,
        authorization_endpoint: `${publicOrigin}/oauth/authorize`,
        token_endpoint: `${publicOrigin}/oauth/token`,
        registration_endpoint: `${publicOrigin}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [...MISSIONGO_SUPPORTED_SCOPES],
      }));

    app.post("/oauth/register", async (request, reply) => {
      try {
        const body = objectBody(request.body);
        const redirectUris = stringArrayField(body, "redirect_uris") ?? [];
        const client = oauthProvider.registerClient({
          redirectUris,
          ...(typeof body.client_name === "string" ? { clientName: body.client_name } : {}),
          ...(typeof body.token_endpoint_auth_method === "string" ? { tokenEndpointAuthMethod: body.token_endpoint_auth_method } : {}),
        });
        return reply.header("cache-control", "no-store").status(201).send({
          client_id: client.id,
          client_name: client.name,
          redirect_uris: client.redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
          client_id_issued_at: Math.floor(Date.now() / 1_000),
        });
      } catch {
        return reply.header("cache-control", "no-store").status(400).send({
          error: "invalid_client_metadata",
          error_description: "The client registration metadata is invalid.",
        });
      }
    });

    app.get("/oauth/authorize", async (request, reply) => {
      try {
        const query = request.query as Record<string, unknown>;
        const started = oauthProvider.beginAuthorization({
          clientId: singleQueryValue(query.client_id),
          redirectUri: singleQueryValue(query.redirect_uri),
          responseType: singleQueryValue(query.response_type),
          ...(singleQueryValue(query.state) ? { state: singleQueryValue(query.state) } : {}),
          ...(singleQueryValue(query.scope) ? { scope: singleQueryValue(query.scope) } : {}),
          codeChallenge: singleQueryValue(query.code_challenge),
          codeChallengeMethod: singleQueryValue(query.code_challenge_method),
        } satisfies OAuthAuthorizationInput);
        return reply.header("cache-control", "no-store").type("text/html; charset=utf-8").send(
          oauthLoginPage(started.clientName, started.requestToken, started.scopes, writeTools),
        );
      } catch {
        return reply.header("cache-control", "no-store").status(400).send({
          error: "invalid_request",
          error_description: "The authorization request is invalid or expired.",
        });
      }
    });

    app.post("/oauth/authorize", async (request, reply) => {
      const form = new URLSearchParams(typeof request.body === "string" ? request.body : "");
      const requestToken = form.get("request") ?? "";
      const username = form.get("username")?.trim() ?? "";
      const password = form.get("password") ?? "";
      const now = Date.now();
      if (loginIsRateLimited(request, reply, now)) return reply;
      const account = accountStore.verifyCredentials(username, password);
      if (!account) {
        recordLoginFailure(request, now);
        return reply.header("cache-control", "no-store").type("text/html; charset=utf-8").status(401).send(
          oauthLoginPage(
            oauthProvider.authorizationClientName(requestToken),
            requestToken,
            oauthProvider.authorizationScopes(requestToken),
            writeTools,
            true,
          ),
        );
      }
      loginFailures.delete(request.ip);
      try {
        // The token is issued to whoever just signed in on the consent page, so
        // the AI client inherits that account's product reach and no more.
        const completed = oauthProvider.finishAuthorization(
          requestToken,
          { id: account.id, username: account.email, role: account.role },
          accountStore.credentialsStamp(account),
        );
        const redirect = new URL(completed.redirectUri);
        redirect.searchParams.set("code", completed.code);
        if (completed.state) redirect.searchParams.set("state", completed.state);
        return reply.header("cache-control", "no-store").redirect(redirect.toString());
      } catch {
        return reply.header("cache-control", "no-store").status(400).send({
          error: "invalid_request",
          error_description: "The authorization request is invalid or expired.",
        });
      }
    });

    app.post("/oauth/token", async (request, reply) => {
      const form = new URLSearchParams(typeof request.body === "string" ? request.body : "");
      try {
        const issued = oauthProvider.exchangeCode({
          grantType: form.get("grant_type") ?? "",
          code: form.get("code") ?? "",
          clientId: form.get("client_id") ?? "",
          redirectUri: form.get("redirect_uri") ?? "",
          codeVerifier: form.get("code_verifier") ?? "",
        });
        // Recorded here rather than inside the provider: the provider mints and
        // signs, the database is this layer's business. From now on this
        // authorization can be listed and cut off on its own.
        accountStore.recordAiAuthorization({
          tokenId: issued.claims.tokenId,
          accountId: issued.claims.id,
          clientId: issued.claims.clientId,
          scopes: issued.claims.scopes,
          issuedAt: issued.claims.issuedAt,
          expiresAt: issued.claims.expiresAt,
        });
        return reply.header("cache-control", "no-store").send({
          access_token: issued.accessToken,
          token_type: "Bearer",
          expires_in: issued.expiresIn,
          scope: issued.scope,
        });
      } catch {
        return reply.header("cache-control", "no-store").status(400).send({
          error: "invalid_grant",
          error_description: "The authorization code is invalid, expired, or already used.",
        });
      }
    });
  }

  app.get("/api/v1/auth/session", async (request, reply) => {
    if (!options.adminAccount && !options.adminToken) {
      return reply.header("cache-control", "no-store").send({
        user: { id: "local-admin", username: "local-admin", displayName: "local-admin", role: "admin" },
      });
    }
    const user = sessionUserResponse(request);
    if (!user) {
      return reply.header("cache-control", "no-store").status(401).send({
        type: "urn:missiongo:problem:authentication_required",
        title: "Sign in with the administrator account to continue.",
        status: 401,
        code: "authentication_required",
      });
    }
    return reply.header("cache-control", "no-store").send({ user });
  });

  /**
   * Everything the console needs to draw its first screen, in one request.
   *
   * It used to take three, chained: `/auth/session`, then `/products` (gated on
   * the session), then `/items` and `/components` (gated on the product). Each is
   * a full round trip -- 185-234ms measured against production -- and the first
   * two sat behind full-screen spinners, so the shell could not appear until all
   * of them had returned. The work itself was never the cost: the four queries
   * together take about 15ms of server time, under 3% of the chain.
   *
   * Deliberately additive. Every route it composes stays exactly as it was, and
   * the console still uses them for paging, filtering and product switching --
   * this only collapses the *first* screen.
   */
  app.get("/api/v1/bootstrap", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    reply.header("cache-control", "no-store");

    const user = !options.adminAccount && !options.adminToken
      ? { id: "local-admin", username: "local-admin", displayName: "local-admin", role: "admin" as const }
      : sessionUserResponse(request);
    if (!user) {
      return reply.status(401).send({
        type: "urn:missiongo:problem:authentication_required",
        title: "Sign in with the administrator account to continue.",
        status: 401,
        code: "authentication_required",
      });
    }

    // Same filter the /products route applies. The first screen must not show a
    // product the account cannot open, or the console lands on a picker whose
    // every later request 404s.
    const allProducts = store.listProducts({ includeArchived: includeArchived(query) });
    const reachable = bearerAuthorized(request)
      ? "*" as const
      : accountStore.reachableProductIds(requireAccount(request), "view");
    const products = withAccess(request, reachable === "*" ? allProducts : allProducts.filter((entry) => reachable.includes(entry.id)));
    // The client's remembered product only counts if it still exists and is still
    // visible; otherwise the first one wins. Resolving it here is what lets the
    // items query run in this same request instead of a round trip later, and it
    // settles on the server what the client used to learn by fetching the list.
    const requested = typeof query.productId === "string" ? query.productId : undefined;
    const product = products.find((entry) => entry.id === requested) ?? products[0];
    if (!product) {
      return reply.send({ user, products, productId: null, items: [], components: [] });
    }

    return reply.send({
      user,
      products,
      productId: product.id,
      ...workItemListPage(query, product.id),
      components: store.listComponents(product.id, { includeArchived: true }),
    });
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    if (!options.adminAccount) {
      return reply.status(503).send({
        type: "urn:missiongo:problem:authentication_unavailable",
        title: "Administrator account login is not configured.",
        status: 503,
        code: "authentication_unavailable",
      });
    }
    const now = Date.now();
    if (loginIsRateLimited(request, reply, now)) return reply;

    const body = objectBody(request.body);
    const username = stringField(body, "username")!.trim();
    const password = stringField(body, "password")!;
    const account = accountStore.verifyCredentials(username, password);
    if (!account) {
      recordLoginFailure(request, now);
      // One answer for a wrong password, an unknown address and a suspended
      // account. Distinguishing them turns the sign-in form into a way to find
      // out who has an account here.
      return reply.header("cache-control", "no-store").status(401).send({
        type: "urn:missiongo:problem:invalid_credentials",
        title: "The email address or password is incorrect.",
        status: 401,
        code: "invalid_credentials",
      });
    }

    loginFailures.delete(request.ip);
    // Two objects on purpose: the first is signed into the cookie and must hold
    // nothing that can change without a new sign-in.
    const claims: AdminSessionUser = { id: account.id, username: account.email, role: account.role };
    const token = createAdminSession(options.adminAccount, claims, accountStore.credentialsStamp(account), now);
    return reply
      .header("cache-control", "no-store")
      .header("set-cookie", adminSessionCookie(options.adminAccount, token))
      .send({ user: authenticatedUser(account) });
  });

  /**
   * Change your own sign-in address.
   *
   * Separate from the administrator's route below, and gated on the current
   * password rather than on the session: the address is what you sign in with.
   */
  app.post("/api/v1/auth/email", async (request, reply) => {
    if (!options.adminAccount) {
      return reply.status(503).send({
        type: "urn:missiongo:problem:authentication_unavailable",
        title: "Administrator account login is not configured.",
        status: 503,
        code: "authentication_unavailable",
      });
    }
    const current = requireAccount(request);
    const body = objectBody(request.body);
    const account = accountStore.changeOwnEmail(
      current.id,
      stringField(body, "currentPassword")!,
      stringField(body, "email")!,
    );
    // The signed cookie carries the address it was minted with, and sessionUser
    // reads the account back on every request, so nothing here invalidates it --
    // but the console shows the name from the session, so hand back a cookie
    // that already says the new one.
    const claims: AdminSessionUser = { id: account.id, username: account.email, role: account.role };
    return reply
      .header("cache-control", "no-store")
      .header(
        "set-cookie",
        adminSessionCookie(
          options.adminAccount,
          createAdminSession(options.adminAccount, claims, accountStore.credentialsStamp(account)),
        ),
      )
      .send({ user: authenticatedUser(account) });
  });

  /**
   * Change your own display name.
   *
   * No current password, unlike the address above: a nickname is what your
   * comments are signed with, not what signs you in, so taking one over gains
   * nothing. No fresh cookie either -- the name is resolved per response and was
   * never in the signed payload, so nothing the browser holds went stale.
   */
  app.post("/api/v1/auth/nickname", async (request, reply) => {
    if (!options.adminAccount) {
      return reply.status(503).send({
        type: "urn:missiongo:problem:authentication_unavailable",
        title: "Administrator account login is not configured.",
        status: 503,
        code: "authentication_unavailable",
      });
    }
    const current = requireAccount(request);
    const account = accountStore.changeOwnNickname(
      current.id,
      nullableStringField(objectBodyOrEmpty(request.body), "nickname") ?? null,
    );
    return reply.header("cache-control", "no-store").send({ user: authenticatedUser(account) });
  });

  /**
   * Change your own password.
   *
   * The current password is required even though the caller already holds a
   * session: a cookie proves the browser was left signed in, not that the person
   * at the keyboard is the owner. Succeeding invalidates every session and AI
   * token the account holds, so a fresh cookie goes back with the response --
   * otherwise changing your password would sign you out of the tab you did it in.
   */
  app.post("/api/v1/auth/password", async (request, reply) => {
    if (!options.adminAccount) {
      return reply.status(503).send({
        type: "urn:missiongo:problem:authentication_unavailable",
        title: "Administrator account login is not configured.",
        status: 503,
        code: "authentication_unavailable",
      });
    }
    const current = requireAccount(request);
    const body = objectBody(request.body);
    const account = accountStore.changeOwnPassword(
      current.id,
      stringField(body, "currentPassword")!,
      stringField(body, "newPassword")!,
    );
    const claims: AdminSessionUser = { id: account.id, username: account.email, role: account.role };
    return reply
      .header("cache-control", "no-store")
      .header(
        "set-cookie",
        adminSessionCookie(
          options.adminAccount,
          createAdminSession(options.adminAccount, claims, accountStore.credentialsStamp(account)),
        ),
      )
      .send({ user: authenticatedUser(account) });
  });

  app.post("/api/v1/auth/logout", async (_request, reply) => {
    if (options.adminAccount) reply.header("set-cookie", expiredAdminSessionCookie(options.adminAccount));
    return reply.header("cache-control", "no-store").send({ ok: true });
  });

  if (mcpHandler && options.adminAccount) {
    app.route({
      method: ["GET", "POST", "DELETE"],
      url: "/mcp",
      handler: async (request, reply) => {
        const token = suppliedBearerToken(request);
        const principal = aiPrincipal(token);
        if (!principal || !principal.scopes.includes(MISSIONGO_READ_SCOPE)) {
          return reply
            .header("www-authenticate", `Bearer realm="MissionGo MCP", resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource/mcp", scope="${MISSIONGO_READ_SCOPE}"`)
            .status(401)
            .send({
              type: "urn:missiongo:problem:authentication_required",
              title: "A valid MCP bearer token is required.",
              status: 401,
              code: "authentication_required",
            });
        }

        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (value === undefined || name === "content-length" || name === "host") continue;
          headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
        }
        const method = request.method.toUpperCase();
        const webRequest = new Request(`${publicOrigin}${request.raw.url}`, {
          method,
          headers,
          ...(method === "POST" ? { body: JSON.stringify(request.body) } : {}),
        });
        const response = await mcpHandler.fetch(webRequest, {
          parsedBody: request.body,
          authInfo: {
            token,
            clientId: principal.clientId,
            scopes: [...principal.scopes],
            expiresAt: principal.expiresAt,
            resource: new URL(`${publicOrigin}/mcp`),
            extra: {
              accountId: principal.id,
              username: principal.username,
              displayName: principal.displayName,
              role: principal.role,
              productIds: principal.productIds,
            },
          },
        });
        reply.status(response.status);
        response.headers.forEach((value, name) => reply.header(name, value));
        if (response.body === null) return reply.send();
        return reply.send(Buffer.from(await response.arrayBuffer()));
      },
    });
  }

  const includeArchived = (query: unknown): boolean =>
    typeof query === "object" && query !== null && (query as Record<string, unknown>).includeArchived === "true";

  const requireAccount = (request: FastifyRequest): AccountSnapshot => {
    const account = sessionAccount(request);
    if (!account) throw new MissionGoError("authentication_required", "A signed-in account is required.", 401);
    return account;
  };

  /**
   * Authorize the caller for one product, the same way mcp.ts does for AI
   * clients -- one judgement, applied at both doors.
   *
   * A deployment-level bearer token (ADMIN_API_TOKEN) carries no account, so
   * there is nobody to check permissions for and it passes. That is a known
   * trade-off, recorded in docs/security-boundaries.md: it is an operator
   * credential for a machine, not a way for a person to sign in.
   *
   * Refusal is `notFound`, never 403. Telling someone "you may not see product
   * X" confirms that product X exists, which is the thing they were not allowed
   * to learn. docs/mcp-contract.md already fixes this for the MCP surface.
   */
  /**
   * What the signed-in account may do with each product it can see (AND-68).
   *
   * The console decides what to offer from this -- "start work" asks whether to
   * hand the item to an AI, and has to say so honestly when this account may
   * not -- while the routes still decide what is allowed. The operator token has
   * no account and is refused nothing, so it reads as everything allowed.
   */
  const withAccess = <T extends { readonly id: string }>(
    request: FastifyRequest,
    products: readonly T[],
  ): Array<T & { access: { canOperate: boolean; canUseAi: boolean } }> => {
    if (bearerAuthorized(request)) return products.map((product) => ({ ...product, access: { canOperate: true, canUseAi: true } }));
    const account = requireAccount(request);
    return products.map((product) => ({
      ...product,
      access: {
        canOperate: accountStore.allows(account, product.id, "operate"),
        canUseAi: accountStore.allows(account, product.id, "ai"),
      },
    }));
  };

  const requireProductPermission = (
    request: FastifyRequest,
    productId: string,
    capability: ProductCapability = "view",
  ): void => {
    if (bearerAuthorized(request)) return;
    if (!accountStore.allows(requireAccount(request), productId, capability)) throw notFound("Product");
  };

  const requireItemPermission = (
    request: FastifyRequest,
    itemKey: string,
    capability: ProductCapability = "view",
  ): string => {
    const normalizedKey = itemKey.toUpperCase();
    if (bearerAuthorized(request)) return normalizedKey;
    // getWorkItem throws notFound for an unknown key, which is the same answer
    // an unauthorized one gets -- so the two stay indistinguishable.
    requireProductPermission(request, store.getWorkItem(normalizedKey).productId, capability);
    return normalizedKey;
  };

  /**
   * Retiring a product, and deciding who else reaches it, are the creator's
   * call or an administrator's.
   *
   * Item 3.2: a member archives what they created, not what was shared with
   * them. A product with no recorded creator predates this and belongs to the
   * administrator who ran the deployment, which is what the seed backfill
   * records -- so an unowned product here means a member, and a member does not
   * get to retire it. A creator who was since deleted leaves the id dangling
   * rather than NULL, and nothing backfills that one: it matches no live
   * account, so only an administrator can act on it, which is the safe way for
   * that case to fail.
   *
   * `action` only names the thing being refused. Callers put a product the
   * account cannot see behind `requireProductPermission` first, so 403 here
   * always means "you can see it, it just is not yours" -- never a hint that a
   * product you were not allowed to know about exists.
   */
  const requireProductOwnership = (request: FastifyRequest, productId: string, action: string): void => {
    if (bearerAuthorized(request)) return;
    const account = requireAccount(request);
    if (account.role === "admin") return;
    if (store.getProduct(productId).createdByAccountId !== account.id) {
      throw new MissionGoError(
        "product_not_owned",
        `Only the account that created this product, or an administrator, can ${action}.`,
        403,
      );
    }
  };

  /**
   * The same product check, for a machine rather than a person.
   *
   * A node presents its own credential and has no session, but it was
   * registered by an account and inherits that account's reach -- otherwise a
   * member's Mac could map a checkout to a product its owner cannot see.
   */
  const requireNodeAccountPermission = (accountId: string, productId: string): void => {
    if (unauthenticatedDeployment) return;
    const account = accountStore.findActive(accountId);
    if (!account || !accountStore.allows(account, productId, "view")) throw notFound("Product");
  };

  /** Only an administrator manages accounts. Everyone else is told there is nothing there. */
  const requireAdmin = (request: FastifyRequest): void => {
    if (bearerAuthorized(request)) return;
    if (requireAccount(request).role !== "admin") throw notFound("Account");
  };

  app.get("/api/v1/ai/title-settings", async (request) => {
    requireAdmin(request);
    return { configured: aiTitle.configured() };
  });

  app.put("/api/v1/ai/title-settings", async (request) => {
    requireAdmin(request);
    const body = objectBody(request.body);
    if (body.apiKey !== null && typeof body.apiKey !== "string") {
      throw invalidInput("apiKey must be a string or null.");
    }
    aiTitle.setKey(body.apiKey);
    return { configured: aiTitle.configured() };
  });

  const titleRequests = new Map<string, { count: number; until: number }>();
  app.post("/api/v1/ai/title", async (request) => {
    const body = objectBody(request.body);
    const productId = stringField(body, "productId")!;
    requireProductPermission(request, productId, "operate");
    const accountId = bearerAuthorized(request) ? "operator" : requireAccount(request).id;
    const now = Date.now();
    const current = titleRequests.get(accountId);
    const next = current && current.until > now ? { count: current.count + 1, until: current.until } : { count: 1, until: now + 60_000 };
    titleRequests.set(accountId, next);
    if (next.count > 10) throw new MissionGoError("ai_rate_limited", "Please wait before generating another title.", 429);
    return { title: await aiTitle.generate(stringField(body, "content")!) };
  });

  app.get("/api/v1/products", async (request) => {
    const products = store.listProducts({ includeArchived: includeArchived(request.query) });
    if (bearerAuthorized(request)) return withAccess(request, products);
    const reachable = accountStore.reachableProductIds(requireAccount(request), "view");
    return withAccess(request, reachable === "*" ? products : products.filter((product) => reachable.includes(product.id)));
  });

  /**
   * Account management. Administrators only, and invisible to everyone else --
   * a member asking who else has an account is told there is nothing here, not
   * that they are not allowed to know.
   *
   * There is no public registration: an administrator creates the account and
   * sets a first password, and the owner changes it from their own settings.
   * That is what README and docs/product-and-technical-plan.md have always said
   * this deployment is, and multi-account does not change it.
   */
  app.get("/api/v1/accounts", async (request) => {
    requireAdmin(request);
    return {
      accounts: accountStore.listAccounts().map((account) => ({
        ...account,
        permissions: accountStore.listPermissions(account.id),
      })),
    };
  });

  app.post("/api/v1/accounts", async (request, reply) => {
    requireAdmin(request);
    const body = objectBody(request.body);
    const account = accountStore.createAccount({
      email: normalizeEmail(stringField(body, "email")!),
      password: stringField(body, "password")!,
      role: enumField(body, "role", ["admin", "member"] as const) ?? "member",
    });
    return reply.status(201).send({ ...account, permissions: accountStore.listPermissions(account.id) });
  });

  app.patch("/api/v1/accounts/:accountId", async (request) => {
    requireAdmin(request);
    const { accountId } = request.params as { accountId: string };
    const body = objectBody(request.body);
    const account = accountStore.updateAccount(accountId, {
      ...(body.email !== undefined ? { email: stringField(body, "email")! } : {}),
      ...(body.nickname !== undefined ? { nickname: nullableStringField(body, "nickname")! } : {}),
      ...(body.role !== undefined ? { role: enumField(body, "role", ["admin", "member"] as const)! } : {}),
      ...(body.disabled !== undefined ? { disabled: booleanField(body, "disabled") } : {}),
      ...(body.password !== undefined ? { password: stringField(body, "password")! } : {}),
    });
    return { ...account, permissions: accountStore.listPermissions(account.id) };
  });

  app.delete("/api/v1/accounts/:accountId", async (request, reply) => {
    requireAdmin(request);
    const { accountId } = request.params as { accountId: string };
    accountStore.deleteAccount(accountId);
    return reply.status(204).send();
  });

  /**
   * Set what one account reaches, from the account's side.
   *
   * The whole set is replaced rather than patched, so what the console shows and
   * what it sends are the same shape and a dropped row cannot be mistaken for
   * "leave that one alone". The product's side of the same relation -- picking
   * accounts from a product's settings -- is a later item.
   */
  app.put("/api/v1/accounts/:accountId/products", async (request) => {
    requireAdmin(request);
    const { accountId } = request.params as { accountId: string };
    const body = objectBody(request.body);
    const entries = Array.isArray(body.permissions) ? body.permissions : undefined;
    if (!entries) throw invalidInput("permissions must be an array.");
    const permissions: ProductPermission[] = entries.map((entry) => {
      const permission = objectBody(entry);
      const productId = stringField(permission, "productId")!;
      // Reject unknown products here rather than storing a row that points at
      // nothing; the foreign key would refuse it anyway, less legibly.
      store.getProduct(productId);
      return {
        productId,
        canView: permission.canView === true,
        canOperate: permission.canOperate === true,
        canUseAi: permission.canUseAi === true,
      };
    });
    return { permissions: accountStore.replacePermissions(accountId, permissions) };
  });

  /**
   * The same account-and-product relation, read and written from the product's
   * side (item 2.2). The account side answers "what may this person reach";
   * this answers "who may reach this product", which is the question you have
   * while looking at a product's settings.
   *
   * An administrator or the product's creator (AND-58). A member who had a
   * product shared with them still has no say in who else reaches it: the two
   * guards below answer them 404 for a product they cannot see at all, and 403
   * for one they can see but did not create.
   *
   * Authorizing needs `view`, not `operate`. Operate is for changing the
   * product's contents; deciding who reaches it belongs to whoever owns it, and
   * asking for operate as well would let an administrator who untickes the
   * creator's operate box take the product away from them by accident.
   */
  /**
   * The account an entry names by email.
   *
   * A product's creator can add someone without being able to list who has an
   * account here, so the address is typed rather than picked, and the server
   * looks it up. It does not create the account: there is no public
   * registration, and an administrator setting a first password is still how
   * someone gets one.
   *
   * One error covers "no such address" and "suspended", so the reply says only
   * whether this address can be added. It still tells a member whether a guessed
   * address exists, which is the price of adding people by address at all;
   * docs/security-boundaries.md records it next to the roster decision it
   * follows from.
   */
  const resolveGrantee = (email: string | undefined): string => {
    if (!email) throw invalidInput("Each entry needs an accountId or an email.");
    const grantee = accountStore.findGrantableByEmail(normalizeEmail(email));
    if (!grantee) {
      throw new MissionGoError(
        "account_not_grantable",
        "No account here can be given access with that email address.",
        400,
      );
    }
    return grantee.id;
  };

  const productAccessGuard = (request: FastifyRequest, productId: string): AccountSnapshot | undefined => {
    // Order matters. `view` refuses a product the caller cannot see with a 404,
    // so ownership never gets the chance to confirm, with its 403, that a
    // product they were not allowed to know about exists.
    requireProductPermission(request, productId, "view");
    requireProductOwnership(request, productId, "manage who reaches it");
    store.getProduct(productId);
    // A deployment token carries no account, and an unauthenticated deployment
    // has none to carry. Both are already past every product check; there is
    // nobody to hide the roster from and nobody for the guards below to protect.
    return bearerAuthorized(request) ? undefined : requireAccount(request);
  };

  /**
   * One exit for both routes.
   *
   * The PUT returns the list too, so reading and writing have to narrow it the
   * same way: otherwise a member creator who cannot list the roster through GET
   * would get it back in the response to a save.
   */
  const productAccessFor = (productId: string, account: AccountSnapshot | undefined) =>
    accountStore.listProductAccess(productId, { rosterHidden: account !== undefined && account.role !== "admin" });

  app.get("/api/v1/products/:productId/accounts", async (request) => {
    const { productId } = request.params as { productId: string };
    const account = productAccessGuard(request, productId);
    return { accounts: productAccessFor(productId, account) };
  });

  app.put("/api/v1/products/:productId/accounts", async (request) => {
    const { productId } = request.params as { productId: string };
    const account = productAccessGuard(request, productId);
    const body = objectBody(request.body);
    const entries = Array.isArray(body.accounts) ? body.accounts : undefined;
    if (!entries) throw invalidInput("accounts must be an array.");
    // A member editor sends one row per person on screen, so the request is
    // bounded by the roster. The cap is here because nothing else bounds it, and
    // every entry costs an account lookup inside one transaction.
    if (entries.length > MAX_PRODUCT_ACCESS_ENTRIES) {
      throw invalidInput(`accounts must hold at most ${MAX_PRODUCT_ACCESS_ENTRIES} entries.`);
    }

    // Resolve first, then judge, then write. The guards below are about which
    // account an entry points at, and an entry can name it by email, so judging
    // the request as it arrived would let `{ email }` walk straight past a check
    // that only knew how to read `accountId`.
    type ResolvedEntry = {
      accountId: string;
      /** True when the entry named the account by address rather than by id. */
      byEmail: boolean;
      permission: { canView: boolean; canOperate: boolean; canUseAi: boolean };
    };
    const resolved = new Map<string, ResolvedEntry>();
    for (const entry of entries) {
      const record = objectBody(entry);
      const byEmail = record.accountId === undefined;
      const accountId = byEmail ? resolveGrantee(stringField(record, "email")) : stringField(record, "accountId")!;
      // Two entries for one account would otherwise be applied in order, and a
      // guard that passed on the first could be undone by the second.
      if (resolved.has(accountId)) throw invalidInput("accounts must not name the same account twice.");
      const canOperate = record.canOperate === true;
      const canUseAi = record.canUseAi === true;
      resolved.set(accountId, {
        accountId,
        byEmail,
        // Normalize here as well as in the store, so a guard comparing this
        // against what is stored compares like with like.
        permission: { canView: record.canView === true || canOperate || canUseAi, canOperate, canUseAi },
      });
    }

    if (account && account.role !== "admin") {
      // The narrowed list, not the full one: it is exactly what this caller was
      // shown, so "was this row on their screen" and "what does it hold now" are
      // the same lookup. The full list has an entry for every account, holding
      // nothing, which would make every id look like one they had been given.
      const current = new Map(
        accountStore.listProductAccess(productId, { rosterHidden: true }).map((entry) => [entry.account.id, entry]),
      );
      for (const entry of resolved.values()) {
        const held = current.get(entry.accountId);
        // The editor submits every row it drew, including the ones it drew
        // read-only, so an entry that asks for exactly what is already stored is
        // not an attempt to cross these lines -- refusing it would make every
        // save from that editor fail.
        if (held
          && held.permission.canView === entry.permission.canView
          && held.permission.canOperate === entry.permission.canOperate
          && held.permission.canUseAi === entry.permission.canUseAi) continue;
        // A member's editor only ever sends back ids it was shown, plus whoever
        // it just looked up by address. An id that is neither is an id this
        // caller had no way to learn, so it gets the same answer as an address
        // nobody holds -- otherwise guessing ids would reach accounts that
        // deciding not to list the roster was meant to keep out of reach.
        if (!held && !entry.byEmail) {
          throw new MissionGoError(
            "account_not_grantable",
            "No account here can be given access with that email address.",
            400,
          );
        }
        if (entry.accountId === account.id) {
          throw new MissionGoError(
            "own_access_unchangeable",
            "You cannot change your own access to a product you created. Ask an administrator.",
            403,
          );
        }
        if (held?.account.role === "admin") {
          throw new MissionGoError(
            "admin_access_unchangeable",
            "An administrator reaches this product by role. Only an administrator can change their row.",
            403,
          );
        }
      }
    }

    accountStore.replaceProductAccess(productId, [...resolved.values()]);
    return { accounts: productAccessFor(productId, account) };
  });

  /**
   * The AI clients connected to your account, and cutting one off.
   *
   * Your own, not anyone else's: an administrator manages accounts, but an
   * authorization is a credential its owner granted, and reading or revoking
   * someone else's is not account management. Suspending the account remains the
   * administrator's lever, and stops all of them at once.
   */
  app.get("/api/v1/ai-authorizations", async (request) => {
    const account = requireAccount(request);
    return {
      authorizations: accountStore.listAiAuthorizations(account.id).map((authorization) => ({
        ...authorization,
        ...(oauthProvider?.clientDisplayName(authorization.clientId)
          ? { clientName: oauthProvider.clientDisplayName(authorization.clientId) }
          : {}),
      })),
    };
  });

  app.delete("/api/v1/ai-authorizations/:authorizationId", async (request, reply) => {
    const account = requireAccount(request);
    const { authorizationId } = request.params as { authorizationId: string };
    accountStore.revokeAiAuthorization(account.id, authorizationId);
    return reply.status(204).send();
  });

  // Dispatching work to a machine. The console half of this is account-scoped
  // and needs a session; the node half below authenticates with the machine's
  // own credential.
  const requireAccountId = (request: FastifyRequest): string => requireAccount(request).id;

  // Mappings are shown and replaced only for products the signed-in account can
  // still see; one it has lost stays on the machine untouched rather than
  // turning every later save into a 404.
  const consoleProductScope = (request: FastifyRequest): "*" | readonly string[] =>
    accountStore.reachableProductIds(requireAccount(request), "view");

  app.get("/api/v1/nodes", async (request) => ({
    nodes: dispatchStore.listNodes(requireAccountId(request), consoleProductScope(request)),
  }));

  app.patch("/api/v1/nodes/:nodeId", async (request) => {
    const { nodeId } = request.params as { nodeId: string };
    return dispatchStore.setNickname(requireAccountId(request), nodeId, nicknameField(objectBody(request.body)));
  });

  app.delete("/api/v1/nodes/:nodeId", async (request, reply) => {
    const { nodeId } = request.params as { nodeId: string };
    dispatchStore.revokeNode(requireAccountId(request), nodeId);
    return reply.status(204).send();
  });

  app.put("/api/v1/nodes/:nodeId/repos", async (request) => {
    const { nodeId } = request.params as { nodeId: string };
    const body = objectBody(request.body);
    const repos = Array.isArray(body.repos) ? body.repos : undefined;
    if (!repos) throw invalidInput("repos must be an array.");
    return {
      repos: dispatchStore.replaceRepos(
        requireAccountId(request),
        nodeId,
        repos.map((entry) => {
          const repo = objectBody(entry);
          const productId = stringField(repo, "productId")!;
          // A checkout mapping names a product, so it is as product-scoped as
          // anything else -- otherwise it is a way to learn that a product you
          // cannot see exists.
          requireProductPermission(request, productId);
          return { productId, repoPath: stringField(repo, "repoPath")! };
        }),
        consoleProductScope(request),
      ),
    };
  });

  // `active` keeps its conflict-checking contract. `latest` is presentation:
  // it also includes a failed attempt, so a ready row can say that it failed
  // without making that failure block a retry.
  app.get("/api/v1/dispatches/active", async (request) => ({
    active: dispatchStore.listActiveDispatches(requireAccountId(request)),
    latest: dispatchStore.listLatestDispatches(requireAccountId(request)),
  }));

  app.post("/api/v1/dispatches", async (request, reply) => {
    const body = objectBody(request.body);
    const accountId = requireAccountId(request);
    const itemKeys = stringArrayField(body, "itemKeys");
    if (!itemKeys) throw invalidInput("itemKeys must be an array of work item keys.");
    // Handing work to a machine is acting on it, so every key in the batch has
    // to be one this account may operate on. Checked before anything is created,
    // so a batch with one unreachable item dispatches nothing.
    const authorizedKeys = itemKeys.map((key) => requireItemPermission(request, key, "operate"));
    // Handing work to an AI is what the product's "AI" permission is for
    // (AND-68). Checked after operate, so an item this account cannot reach at
    // all still reads as not found rather than confirming it exists.
    if (!bearerAuthorized(request)) {
      const account = requireAccount(request);
      for (const key of authorizedKeys) {
        if (!accountStore.allows(account, store.getWorkItem(key).productId, "ai")) {
          throw new MissionGoError("ai_not_permitted", `This account may not hand ${key} to an AI agent.`, 403);
        }
      }
    }
    const dispatch = dispatchStore.createDispatch({
      accountId,
      nodeId: stringField(body, "nodeId")!,
      agentKind: stringField(body, "agentKind")! as AgentKind,
      mode: stringField(body, "mode")!,
      itemKeys: authorizedKeys,
      force: body.force === true,
    });
    for (const itemId of dispatchStore.listDispatchItemIds(dispatch.id)) {
      store.appendSystemEvent(itemId, "dispatched", {
        dispatchId: dispatch.id,
        nodeName: dispatch.nodeName,
        agentKind: dispatch.agentKind,
        mode: dispatch.mode,
        itemKeys: dispatch.itemKeys,
      });
    }
    return reply.status(201).send(dispatch);
  });

  app.get("/api/v1/items/:itemKey/dispatches", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    const key = requireItemPermission(request, itemKey);
    return { dispatches: dispatchStore.listDispatchesForItem(requireAccountId(request), key) };
  });

  const authorizedDispatch = (request: FastifyRequest, dispatchId: string, operate = false) => {
    const account = requireAccount(request);
    const dispatch = dispatchStore.getDispatch(account.id, dispatchId);
    for (const itemKey of dispatch.itemKeys) {
      const key = requireItemPermission(request, itemKey, operate ? "operate" : "view");
      if (operate && !accountStore.allows(account, store.getWorkItem(key).productId, "ai")) {
        throw new MissionGoError("ai_not_permitted", `This account may not control the AI dispatch for ${key}.`, 403);
      }
    }
    return dispatch;
  };

  const authorizedAgentSession = (request: FastifyRequest, sessionId: string, reply = false) => {
    const account = requireAccount(request);
    const session = agentSessionStore.getForAccount(account.id, sessionId);
    const dispatch = dispatchStore.getDispatch(account.id, session.dispatchId);
    for (const itemKey of dispatch.itemKeys) {
      const key = requireItemPermission(request, itemKey, reply ? "operate" : "view");
      if (reply && !accountStore.allows(account, store.getWorkItem(key).productId, "ai")) {
        throw new MissionGoError("ai_not_permitted", `This account may not reply to the AI session for ${key}.`, 403);
      }
    }
    return session;
  };

  app.get("/api/v1/agent-sessions/:sessionId", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    return authorizedAgentSession(request, sessionId);
  });

  app.get("/api/v1/agent-sessions", async (request) => {
    const account = requireAccount(request);
    const { productId } = request.query as { productId?: string };
    const selectedProductId = productId?.trim();
    if (selectedProductId) requireProductPermission(request, selectedProductId, "view");
    const sessions = agentSessionStore.listForAccount(account.id)
      .filter((session) => session.items.length > 0
        && session.items.every((item) => accountStore.allows(account, item.productId, "view")))
      .filter((session) => !selectedProductId
        || session.items.some((item) => item.productId === selectedProductId))
      .map((session) => ({
        ...session,
        canReply: Boolean(session.agentSessionId) && !session.archivedAt && !session.nodeRevoked && session.items.every((item) =>
          accountStore.allows(account, item.productId, "operate")
          && accountStore.allows(account, item.productId, "ai")),
        canRetry: !session.archivedAt && !session.nodeRevoked && session.retryable && session.items.every((item) =>
          accountStore.allows(account, item.productId, "operate")
          && accountStore.allows(account, item.productId, "ai")),
        canStop: !session.archivedAt && !session.nodeRevoked && session.stoppable && session.items.every((item) =>
          accountStore.allows(account, item.productId, "operate")
          && accountStore.allows(account, item.productId, "ai")),
        canArchive: Boolean(session.agentSessionId) && session.items.every((item) =>
          accountStore.allows(account, item.productId, "operate")
          && accountStore.allows(account, item.productId, "ai")),
      }));
    return { sessions };
  });

  app.patch("/api/v1/agent-sessions/:sessionId", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    authorizedAgentSession(request, sessionId, true);
    const body = objectBody(request.body);
    return agentSessionStore.setArchived(
      requireAccountId(request),
      sessionId,
      booleanField(body, "archived"),
    );
  });

  app.post("/api/v1/agent-sessions/:sessionId/commands", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    authorizedAgentSession(request, sessionId, true);
    const command = agentSessionStore.enqueue(
      requireAccountId(request),
      sessionId,
      stringField(objectBody(request.body), "text")!,
    );
    return reply.status(201).send(command);
  });

  app.post("/api/v1/dispatches/:dispatchId/retry", async (request, reply) => {
    const { dispatchId } = request.params as { dispatchId: string };
    const original = authorizedDispatch(request, dispatchId, true);
    if (original.status !== "failed" && original.status !== "cancelled") {
      throw conflict("dispatch_not_retryable", "Only failed or cancelled dispatches can be sent again.");
    }
    const dispatch = dispatchStore.createDispatch({
      accountId: requireAccountId(request),
      nodeId: original.nodeId,
      agentKind: original.agentKind,
      mode: original.mode,
      itemKeys: original.itemKeys,
    });
    for (const itemId of dispatchStore.listDispatchItemIds(dispatch.id)) {
      store.appendSystemEvent(itemId, "dispatched", {
        dispatchId: dispatch.id,
        nodeName: dispatch.nodeName,
        agentKind: dispatch.agentKind,
        mode: dispatch.mode,
        itemKeys: dispatch.itemKeys,
      });
    }
    return reply.status(201).send(dispatch);
  });

  app.post("/api/v1/dispatches/:dispatchId/stop", async (request, reply) => {
    const { dispatchId } = request.params as { dispatchId: string };
    const dispatch = authorizedDispatch(request, dispatchId, true);
    if (dispatch.status === "queued") {
      return { dispatch: dispatchStore.cancelQueuedDispatch(requireAccountId(request), dispatchId) };
    }
    if (dispatch.agentSessionId) {
      authorizedAgentSession(request, dispatch.agentSessionId, true);
      const command = agentSessionStore.enqueueInterrupt(
        requireAccountId(request),
        dispatch.agentSessionId,
      );
      return reply.status(202).send({ command });
    }
    throw conflict("dispatch_not_stoppable", "This dispatch cannot be stopped from MissionGo.");
  });

  app.post("/api/v1/agent-sessions/:sessionId/commands/:commandId/cancel", async (request) => {
    const { sessionId, commandId } = request.params as { sessionId: string; commandId: string };
    authorizedAgentSession(request, sessionId, true);
    return agentSessionStore.cancel(requireAccountId(request), sessionId, commandId);
  });

  // The macOS client signs in through the same OAuth flow as an AI client, with
  // the node scope, and trades that login for a machine credential here. The
  // login token is not accepted anywhere else on /api/v1 and the client drops it
  // straight after: it lasts 30 days and cannot be revoked on its own, while the
  // node credential can be revoked from the console at any time.
  app.post("/api/v1/node/register", async (request, reply) => {
    const principal = aiPrincipal(suppliedBearerToken(request));
    if (!principal || !principal.scopes.includes(MISSIONGO_NODE_SCOPE)) {
      throw new MissionGoError(
        "authentication_required",
        "Sign in from the MissionGo macOS client to register this machine.",
        401,
      );
    }
    const body = objectBody(request.body);
    const credential = dispatchStore.registerNode({
      accountId: principal.id,
      installationId: stringField(body, "installationId")!,
      name: stringField(body, "name")!,
      ...(stringField(body, "hostname", false) ? { hostname: body.hostname as string } : {}),
    });
    return reply.status(201).send(credential);
  });

  const requireNode = (request: FastifyRequest): { nodeId: string; accountId: string } => {
    const node = dispatchStore.authenticateNode(suppliedBearerToken(request));
    // A machine acts for the account that registered it, so it stops when that
    // account does: disabling or deleting an account has to cut off its Macs
    // too, or they keep pulling queued work and product names.
    if (!node || (!unauthenticatedDeployment && !accountStore.findActive(node.accountId))) {
      throw new MissionGoError("authentication_required", "A valid node bearer token is required.", 401);
    }
    return node;
  };

  // The products a machine may be given a repository for. Every answer the
  // client gets carries the current list, so a product created in the console
  // reaches the menu without the client being restarted.
  /**
   * The products a machine may be given a checkout for: the ones its owning
   * account reaches, not every product on the deployment. The client draws its
   * menu from this, so an unfiltered list would name other people's products on
   * someone's Mac.
   */
  const nodeProductScope = (accountId: string): "*" | readonly string[] => {
    if (unauthenticatedDeployment) return "*";
    // No active account means nothing to reach. This used to fall back to "*",
    // which handed a disabled account's Mac every product on the deployment.
    const account = accountStore.findActive(accountId);
    return account ? accountStore.reachableProductIds(account, "view") : [];
  };
  const nodeProducts = (accountId: string) => {
    const reachable = nodeProductScope(accountId);
    return store.listProducts()
      .filter((product) => reachable === "*" || reachable.includes(product.id))
      .map((product) => ({ id: product.id, keyPrefix: product.keyPrefix, name: product.name }));
  };

  // What the client shows and edits about its own Mac. These take the node
  // credential rather than a console session: the client has no browser cookie,
  // and a machine may only ever see and change its own mapping.
  app.patch("/api/v1/node/me", async (request) => {
    const node = requireNode(request);
    dispatchStore.setOwnNickname(node.nodeId, nicknameField(objectBody(request.body)));
    return dispatchStore.describeSelf(node.nodeId, nodeProducts(node.accountId));
  });

  app.get("/api/v1/node/me", async (request) => {
    const node = requireNode(request);
    return dispatchStore.describeSelf(node.nodeId, nodeProducts(node.accountId));
  });

  app.put("/api/v1/node/repos", async (request) => {
    const node = requireNode(request);
    const body = objectBody(request.body);
    const repos = Array.isArray(body.repos) ? body.repos : undefined;
    if (!repos) throw invalidInput("repos must be an array.");
    return {
      repos: dispatchStore.replaceOwnRepos(
        node.nodeId,
        repos.map((entry) => {
          const repo = objectBody(entry);
          const productId = stringField(repo, "productId")!;
          // The machine presents its own credential, not a session, so the
          // account to check is the one that registered it.
          requireNodeAccountPermission(node.accountId, productId);
          return { productId, repoPath: stringField(repo, "repoPath")! };
        }),
        nodeProductScope(node.accountId),
      ),
    };
  });

  app.get("/api/v1/node/dispatches", async (request) => {
    const node = requireNode(request);
    return { dispatches: dispatchStore.listDispatchesForNode(node.nodeId) };
  });

  app.get("/api/v1/node/agent-sessions", async (request) => {
    const node = requireNode(request);
    return { sessions: agentSessionStore.listForNode(node.nodeId) };
  });

  app.post("/api/v1/node/agent-sessions/:sessionId/snapshot", async (request, reply) => {
    const node = requireNode(request);
    const { sessionId } = request.params as { sessionId: string };
    const body = objectBody(request.body);
    const status = stringField(body, "status") as AgentSessionStatus;
    if (!["active", "idle", "unavailable", "failed"].includes(status)) {
      throw invalidInput("status must be active, idle, unavailable, or failed.");
    }
    if (!Array.isArray(body.messages)) throw invalidInput("messages must be an array.");
    const messages = body.messages.map((entry) => {
      const message = objectBody(entry);
      const role = stringField(message, "role") as AgentMessageRole;
      if (!["user", "agent", "plan"].includes(role)) {
        throw invalidInput("message role must be user, agent, or plan.");
      }
      let questions: Array<{ title: string; options?: string[] }> | undefined;
      if (message.questions !== undefined) {
        if (!Array.isArray(message.questions)) throw invalidInput("questions must be an array.");
        questions = message.questions.map((entry) => {
          const question = objectBody(entry);
          const options = stringArrayField(question, "options");
          return {
            title: stringField(question, "title")!,
            ...(options ? { options: [...options] } : {}),
          };
        });
      }
      return {
        sourceId: stringField(message, "sourceId")!,
        ...(stringField(message, "turnId", false) ? { turnId: message.turnId as string } : {}),
        role,
        ...(stringField(message, "phase", false) ? { phase: message.phase as string } : {}),
        text: stringField(message, "text")!,
        ...(questions ? { questions } : {}),
      };
    });
    const commandStatusValue = stringField(body, "commandStatus", false);
    if (commandStatusValue && !["delivering", "delivered", "failed"].includes(commandStatusValue)) {
      throw invalidInput("commandStatus must be delivering, delivered, or failed.");
    }
    const commandStatus = commandStatusValue as "delivering" | "delivered" | "failed" | undefined;
    if (body.sourceArchived !== undefined && typeof body.sourceArchived !== "boolean") {
      throw invalidInput("sourceArchived must be true or false.");
    }
    agentSessionStore.recordSnapshot({
      nodeId: node.nodeId,
      sessionId,
      status,
      messages,
      ...(stringField(body, "error", false) ? { error: body.error as string } : {}),
      ...(stringField(body, "commandId", false) ? { commandId: body.commandId as string } : {}),
      ...(commandStatus ? { commandStatus } : {}),
      ...(stringField(body, "commandError", false) ? { commandError: body.commandError as string } : {}),
      ...(typeof body.sourceArchived === "boolean" ? { sourceArchived: body.sourceArchived } : {}),
    });
    return reply.status(204).send();
  });

  app.post("/api/v1/node/heartbeat", async (request) => {
    const node = requireNode(request);
    const body = objectBody(request.body);
    const agents = Array.isArray(body.agents) ? body.agents : [];
    const repoCandidates = Array.isArray(body.repoCandidates) ? body.repoCandidates : [];
    return {
      // The client polls this every 30 seconds whether or not its menu is open,
      // so it is the one channel that can carry a new product to a machine
      // nobody is looking at.
      products: nodeProducts(node.accountId),
      repos: dispatchStore.recordHeartbeat(
        node.nodeId,
        agents.map((entry) => {
          const agent = objectBody(entry);
          return {
            kind: stringField(agent, "kind")! as AgentKind,
            ...(stringField(agent, "version", false) ? { version: agent.version as string } : {}),
          };
        }),
        repoCandidates.map((entry) => {
          const candidate = objectBody(entry);
          return {
            path: stringField(candidate, "path")!,
            name: stringField(candidate, "name")!,
            ...(stringField(candidate, "lastUsedAt", false) ? { lastUsedAt: candidate.lastUsedAt as string } : {}),
          };
        }),
        nodeProductScope(node.accountId),
      ),
    };
  });

  // Long poll: the machine asks and the request is held open until there is work
  // or the wait runs out. It keeps hand-off under a second without a second
  // protocol — nginx already proxies /api/ with buffering off and a 300s read
  // timeout, which a WebSocket upgrade would have needed configuring for.
  app.post("/api/v1/node/dispatches/claim-next", async (request, reply) => {
    const node = requireNode(request);
    const immediate = dispatchStore.claimNextDispatch(node.nodeId);
    if (immediate) return immediate;

    const requested = Number((objectBodyOrEmpty(request.body).waitMs ?? 0));
    const waitMs = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), MAX_CLAIM_WAIT_MS) : 0;
    if (waitMs > 0) {
      // Stop waiting if the machine hangs up, so a reconnecting daemon does not
      // leave a waiter behind on every retry.
      const abort = new AbortController();
      request.raw.on("close", () => abort.abort());
      await dispatchStore.waitForDispatch(node.nodeId, waitMs, abort.signal);
      const afterWait = dispatchStore.claimNextDispatch(node.nodeId);
      if (afterWait) return afterWait;
    }
    return reply.status(204).send();
  });

  app.post("/api/v1/node/dispatches/:dispatchId/result", async (request, reply) => {
    const node = requireNode(request);
    const { dispatchId } = request.params as { dispatchId: string };
    const body = objectBody(request.body);
    const status = stringField(body, "status")!;
    if (status !== "launched" && status !== "failed") throw invalidInput("status must be launched or failed.");
    dispatchStore.recordDispatchResult({
      nodeId: node.nodeId,
      dispatchId,
      status,
      ...(stringField(body, "sessionName", false) ? { sessionName: body.sessionName as string } : {}),
      ...(stringField(body, "sessionUrl", false) ? { sessionUrl: body.sessionUrl as string } : {}),
      ...(stringField(body, "error", false) ? { error: body.error as string } : {}),
    });
    const sessionRef = stringField(body, "sessionRef", false);
    if (status === "launched" && sessionRef) {
      agentSessionStore.createForDispatch({ dispatchId, nodeId: node.nodeId, sessionRef });
    }
    return reply.status(204).send();
  });

  // An SDK token names a product, so the list is product-scoped like everything
  // else. It used to take no scope at all and hand every caller every token.
  app.get("/api/v1/sdk-tokens", async (request) => {
    const tokens = store.listSdkTokens();
    if (bearerAuthorized(request)) return tokens;
    const reachable = accountStore.reachableProductIds(requireAccount(request), "view");
    return reachable === "*" ? tokens : tokens.filter((token) => reachable.includes(token.productId));
  });

  app.post("/api/v1/sdk-tokens", async (request, reply) => {
    const body = objectBody(request.body);
    requireProductPermission(request, stringField(body, "productId")!, "operate");
    const token = store.createSdkToken({
      name: stringField(body, "name")!,
      productId: stringField(body, "productId")!,
      ...(stringField(body, "sourceComponentId", false)
        ? { sourceComponentId: body.sourceComponentId as string }
        : {}),
      ...(stringField(body, "expiresAt", false) ? { expiresAt: body.expiresAt as string } : {}),
    });
    return reply.status(201).send(token);
  });

  app.delete("/api/v1/sdk-tokens/:tokenId", async (request) => {
    const { tokenId } = request.params as { tokenId: string };
    // Read it first so an unreachable product's token answers "not found"
    // rather than being revoked by someone who cannot see it.
    const token = store.listSdkTokens().find((entry) => entry.id === tokenId);
    if (!token) throw notFound("SDK token");
    requireProductPermission(request, token.productId, "operate");
    return store.revokeSdkToken(tokenId);
  });

  const requireSdkPrincipal = (request: FastifyRequest): SdkPrincipal => {
    const principal = store.authenticateSdkToken(suppliedBearerToken(request));
    if (!principal) throw new MissionGoError("authentication_required", "A valid SDK bearer token is required.", 401);
    return principal;
  };

  const requireDraftPrincipal = (request: FastifyRequest, draftId: string): SdkPrincipal => {
    const bearerPrincipal = store.authenticateSdkToken(suppliedBearerToken(request));
    if (bearerPrincipal) return bearerPrincipal;
    const sessionPrincipal = store.authenticateFeedbackWebSession(
      cookieValue(request, "missiongo_feedback_session"),
      draftId,
    );
    if (sessionPrincipal) return sessionPrincipal;
    throw new MissionGoError("authentication_required", "A valid feedback editing session is required.", 401);
  };

  const enforceSdkRateLimit = (
    reply: FastifyReply,
    principal: SdkPrincipal,
    bucket: SdkRateLimitBucket,
  ): void => {
    const result = store.consumeSdkRateLimit(
      principal,
      bucket,
      sdkRateLimits[bucket].limit,
      sdkRateLimits[bucket].windowMilliseconds,
    );
    reply
      .header("x-ratelimit-limit", result.limit)
      .header("x-ratelimit-remaining", result.remaining)
      .header("x-ratelimit-reset", result.resetAt);
  };

  const upsertSdkDraft = (requestBody: unknown, principal: SdkPrincipal) => {
    const body = objectBody(requestBody);
    const environment = environmentBody(body.environment);
    if (!environment) throw invalidInput("environment.platform is required.");
    return store.upsertFeedbackDraft({
      principal,
      clientDraftId: stringField(body, "clientDraftId")!,
      type: enumField(body, "type", WORK_ITEM_TYPES, false) ?? "bug",
      priority: enumField(body, "priority", WORK_ITEM_PRIORITIES, false) ?? "normal",
      title: stringField(body, "title", false) ?? "",
      description: stringField(body, "description", false) ?? "",
      environment,
      context: stringMapField(body, "context"),
      logs: feedbackLogsField(body),
    });
  };

  app.post("/api/v1/sdk/drafts", async (request, reply) => {
    const principal = requireSdkPrincipal(request);
    enforceSdkRateLimit(reply, principal, "draft_write");
    const draft = upsertSdkDraft(request.body, principal);
    return reply.status(201).send(draft);
  });

  app.post("/api/v1/sdk/editor-session", async (request, reply) => {
    const principal = requireSdkPrincipal(request);
    enforceSdkRateLimit(reply, principal, "draft_write");
    const draft = upsertSdkDraft(request.body, principal);
    if (draft.status === "submitted") return reply.status(200).send(draft);
    enforceSdkRateLimit(reply, principal, "web_session");
    const session = store.createFeedbackWebSession(draft.id, principal);
    return reply.status(201).send({
      ...draft,
      sessionToken: session.token,
      sessionExpiresAt: session.expiresAt,
    });
  });

  app.get("/api/v1/sdk/drafts/:draftId", async (request, reply) => {
    const { draftId } = request.params as { draftId: string };
    const principal = requireDraftPrincipal(request, draftId);
    enforceSdkRateLimit(reply, principal, "draft_read");
    return store.getFeedbackDraft(draftId, principal);
  });

  app.post("/api/v1/sdk/drafts/:draftId/ai-title", async (request, reply) => {
    const { draftId } = request.params as { draftId: string };
    const principal = requireDraftPrincipal(request, draftId);
    const draft = store.getFeedbackDraft(draftId, principal);
    if (draft.status !== "editing") {
      throw conflict("draft_not_editable", "Only an active feedback draft can generate a title.");
    }
    enforceSdkRateLimit(reply, principal, "ai_title");
    return { title: await aiTitle.generate(stringField(objectBody(request.body), "content")!) };
  });

  app.patch("/api/v1/sdk/drafts/:draftId", async (request, reply) => {
    const { draftId } = request.params as { draftId: string };
    const principal = requireDraftPrincipal(request, draftId);
    enforceSdkRateLimit(reply, principal, "draft_write");
    const current = store.getFeedbackDraft(draftId, principal);
    const body = objectBody(request.body);
    const environment = body.environment === undefined ? current.environment : environmentBody(body.environment);
    if (!environment) throw invalidInput("environment.platform is required.");
    return store.upsertFeedbackDraft({
      principal,
      clientDraftId: current.clientDraftId,
      type: body.type === undefined ? current.type : enumField(body, "type", WORK_ITEM_TYPES)!,
      priority: body.priority === undefined ? current.priority : enumField(body, "priority", WORK_ITEM_PRIORITIES)!,
      title: body.title === undefined ? current.title : stringField(body, "title")!,
      description: body.description === undefined ? current.description : stringField(body, "description")!,
      environment,
      context: body.context === undefined ? current.context : stringMapField(body, "context"),
      logs: body.logs === undefined ? current.logs : feedbackLogsField(body),
    });
  });

  app.post("/api/v1/sdk/drafts/:draftId/finalize", async (request, reply) => {
    const { draftId } = request.params as { draftId: string };
    const principal = requireDraftPrincipal(request, draftId);
    enforceSdkRateLimit(reply, principal, "finalize");
    const body = request.body === undefined ? {} : objectBody(request.body);
    const status = enumField(body, "status", ["inbox", "ready"] as const, false) ?? "inbox";
    const draft = store.getFeedbackDraft(draftId, principal);
    const finalized = store.finalizeFeedbackDraft(draftId, principal, status);

    // The diagnostics become a log file rather than part of the creation event,
    // so reading the item does not drag hundreds of entries along with it. The
    // item exists by now, which is what an attachment needs; the draft still
    // holds logs_json, so a failure here loses nothing that cannot be redone.
    // Finalizing is idempotent, so this has to be too -- and checking for the
    // file rather than for a first-time transition also lets a failed write be
    // retried by calling finalize again.
    const logFilename = finalized.itemKey ? `${finalized.itemKey}-diagnostics.log` : "";
    const alreadyWritten = finalized.itemKey
      && store.listAttachments(finalized.itemKey).some((attachment) => attachment.filename === logFilename);
    if (draft.logs.length > 0 && finalized.itemKey && !alreadyWritten) {
      try {
        await attachmentStorage.save(
          store,
          finalized.itemKey,
          encodeURIComponent(logFilename),
          "text/plain",
          Buffer.from(formatFeedbackLog(draft.logs), "utf8"),
        );
      } catch (error) {
        request.log.error({ err: error, itemKey: finalized.itemKey }, "diagnostics log attachment failed");
      }
    }
    return finalized;
  });

  app.post("/api/v1/sdk/drafts/:draftId/web-session", async (request, reply) => {
    const principal = requireSdkPrincipal(request);
    enforceSdkRateLimit(reply, principal, "web_session");
    const { draftId } = request.params as { draftId: string };
    return store.createFeedbackWebSession(draftId, principal);
  });

  app.post("/api/v1/sdk/drafts/:draftId/attachments", async (request, reply) => {
    const { draftId } = request.params as { draftId: string };
    const principal = requireDraftPrincipal(request, draftId);
    enforceSdkRateLimit(reply, principal, "attachment_upload");
    const draft = store.getFeedbackDraft(draftId, principal);
    if (draft.status !== "submitted" || !draft.itemKey) {
      throw new MissionGoError("draft_not_submitted", "Attachments can only be uploaded after the draft is submitted.", 409);
    }
    if (!Buffer.isBuffer(request.body)) throw invalidInput("Attachment body must be binary data.");
    const filename = headerText(request.headers["x-missiongo-filename"], "X-MissionGo-Filename");
    const contentType = headerText(request.headers["x-missiongo-content-type"], "X-MissionGo-Content-Type");
    const clientAttachmentId = headerText(
      request.headers["x-missiongo-client-attachment-id"],
      "X-MissionGo-Client-Attachment-ID",
    );
    const attachment = await attachmentStorage.save(store, draft.itemKey, filename, contentType, request.body, {
      draftId,
      clientAttachmentId,
    });
    return reply.status(201).send(publicAttachment(attachment));
  });

  /**
   * Anyone signed in may start a product; they own what they start.
   *
   * The creator is recorded and immediately granted all three capabilities over
   * it. Without that grant a member creates a product and it vanishes from their
   * own list, which is indistinguishable from the creation having failed.
   */
  app.post("/api/v1/products", async (request, reply) => {
    const body = objectBody(request.body);
    const account = bearerAuthorized(request) ? undefined : requireAccount(request);
    const product = store.createProduct({
      name: stringField(body, "name")!,
      keyPrefix: stringField(body, "keyPrefix")!,
      ...(account ? { createdByAccountId: account.id } : {}),
    });
    // Members only. An administrator already reaches every product by role, so
    // the row would grant nothing -- except that a can_use_ai row is what bounds
    // an administrator's AI clients. Writing one here would take an
    // administrator whose AI could read everything and quietly narrow it to
    // "products I created myself" the first time they made one.
    if (account?.role === "member") accountStore.grantCreatorPermissions(account.id, product.id);
    return reply.status(201).send(product);
  });

  /**
   * The icon as its own cacheable image, rather than base64 inside the product
   * listing. Inlined, one icon cost ~13 KB that gzip could not touch, on the
   * request the console blocks its first paint behind, re-sent on every cold
   * start. As an image it loads beside the first paint instead of before it, and
   * the browser keeps it across launches.
   *
   * `updatedAt` moves whenever the icon is replaced, so it is a sound ETag and
   * lets the caller cache-bust with a query parameter it already has.
   */
  app.get("/api/v1/products/:productId/icon", async (request, reply) => {
    const { productId } = request.params as { productId: string };
    requireProductPermission(request, productId);
    const product = store.getProduct(productId);
    const pngBase64 = store.getProductIconPng(productId);
    if (!pngBase64) throw notFound("Product icon");

    const etag = `"${createHash("sha256").update(`${productId}:${product.updatedAt}`).digest("hex").slice(0, 32)}"`;
    if (request.headers["if-none-match"] === etag) {
      return reply.status(304).header("etag", etag).send();
    }

    const png = Buffer.from(pngBase64, "base64");
    return reply
      .type("image/png")
      .header("content-length", png.length)
      .header("etag", etag)
      // Private: a product icon is workspace content, not public. Short max-age
      // with revalidation keeps a replaced icon from sticking around.
      .header("cache-control", "private, max-age=300, must-revalidate")
      .header("x-content-type-options", "nosniff")
      .send(png);
  });

  // The icon is re-encoded rather than stored as uploaded: it bounds the size,
  // strips whatever metadata the original carried, and means the switcher only
  // ever renders one format.
  app.put("/api/v1/products/:productId/icon", async (request) => {
    const { productId } = request.params as { productId: string };
    requireProductPermission(request, productId, "operate");
    if (!Buffer.isBuffer(request.body)) throw invalidInput("Icon body must be binary image data.");
    if (request.body.length === 0) throw invalidInput("Icon body is empty.");
    let png: Buffer;
    try {
      png = await sharp(request.body, { animated: false })
        .rotate()
        .resize({ width: PRODUCT_ICON_EDGE, height: PRODUCT_ICON_EDGE, fit: "cover", position: "centre" })
        .png({ compressionLevel: 9 })
        .toBuffer();
    } catch {
      throw invalidInput("The icon could not be read as an image.");
    }
    return store.setProductIcon(productId, png.toString("base64"));
  });

  app.delete("/api/v1/products/:productId/icon", async (request) => {
    const { productId } = request.params as { productId: string };
    requireProductPermission(request, productId, "operate");
    return store.setProductIcon(productId, null);
  });

  /**
   * Rename or archive a product.
   *
   * Archiving is the one product action that is not just "operate": it retires
   * the whole workspace for everybody who shares it. An administrator may
   * archive anything; a member only what they created. Renaming stays with
   * operate, because it is reversible and visible.
   */
  app.patch("/api/v1/products/:productId", async (request) => {
    const { productId } = request.params as { productId: string };
    const body = objectBody(request.body);
    requireProductPermission(request, productId, "operate");
    if (body.archived !== undefined) requireProductOwnership(request, productId, "archive it");
    return store.updateProduct(productId, {
      ...(body.name !== undefined ? { name: stringField(body, "name")! } : {}),
      ...(body.archived !== undefined ? { archived: booleanField(body, "archived") } : {}),
    });
  });

  app.get("/api/v1/products/:productId/components", async (request) => {
    const { productId } = request.params as { productId: string };
    requireProductPermission(request, productId);
    return store.listComponents(productId, { includeArchived: includeArchived(request.query) });
  });

  app.post("/api/v1/products/:productId/components", async (request, reply) => {
    const { productId } = request.params as { productId: string };
    requireProductPermission(request, productId, "operate");
    const body = objectBody(request.body);
    const component = store.createComponent({
      productId,
      name: stringField(body, "name")!,
      kind: enumField(body, "kind", COMPONENT_KINDS)! as ComponentKind,
    });
    return reply.status(201).send(component);
  });

  app.patch("/api/v1/products/:productId/components/:componentId", async (request) => {
    const { productId, componentId } = request.params as { productId: string; componentId: string };
    requireProductPermission(request, productId, "operate");
    const body = objectBody(request.body);
    return store.updateComponent(productId, componentId, {
      ...(body.name !== undefined ? { name: stringField(body, "name")! } : {}),
      ...(body.kind !== undefined ? { kind: enumField(body, "kind", COMPONENT_KINDS)! as ComponentKind } : {}),
      ...(body.archived !== undefined ? { archived: booleanField(body, "archived") } : {}),
    });
  });

  /**
   * One page of the item list plus its summary. Shared by `/items` and by
   * `/bootstrap`, so the first screen a cold start renders cannot drift from the
   * one every later filter change fetches.
   */
  function workItemListPage(query: Record<string, unknown>, productId: string) {
    const limit = typeof query.limit === "string" ? Number(query.limit) : undefined;
    const beforeSequence = typeof query.beforeSequence === "string" ? Number(query.beforeSequence) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      throw invalidInput("limit must be an integer between 1 and 100.");
    }
    if (beforeSequence !== undefined && (!Number.isInteger(beforeSequence) || beforeSequence < 1)) {
      throw invalidInput("beforeSequence must be a positive integer.");
    }

    const effectiveLimit = limit ?? 50;
    const items = store.listWorkItems({
      productId,
      ...(typeof query.status === "string" ? { status: query.status as never } : {}),
      ...(typeof query.type === "string" ? { type: query.type as never } : {}),
      ...(typeof query.search === "string" ? { search: query.search } : {}),
      limit: effectiveLimit,
      ...(beforeSequence !== undefined ? { beforeSequence } : {}),
    });
    const nextBeforeSequence = items.length === effectiveLimit
      ? sequenceFromItemKey(items.at(-1)?.key)
      : undefined;
    return {
      items: withCreatorNames(items),
      summary: store.getWorkItemListSummary({
        productId,
        ...(typeof query.type === "string" ? { type: query.type as never } : {}),
        ...(typeof query.search === "string" ? { search: query.search } : {}),
      }),
      ...(nextBeforeSequence !== undefined ? { nextBeforeSequence } : {}),
    };
  }

  app.get("/api/v1/items", async (request) => {
    const query = request.query as Record<string, unknown>;
    const productId = typeof query.productId === "string" ? query.productId : undefined;
    if (!productId) throw invalidInput("productId is required.");
    requireProductPermission(request, productId);
    return workItemListPage(query, productId);
  });

  app.post("/api/v1/items", async (request, reply) => {
    const body = objectBody(request.body);
    const environment = environmentBody(body.environment);
    requireProductPermission(request, stringField(body, "productId")!, "operate");
    const item = store.createWorkItem({
      productId: stringField(body, "productId")!,
      ...(body.status !== undefined ? { status: enumField(body, "status", ["inbox", "ready"] as const)! } : {}),
      ...(stringField(body, "sourceComponentId", false) ? { sourceComponentId: body.sourceComponentId as string } : {}),
      ...(stringArrayField(body, "affectedComponentIds")
        ? { affectedComponentIds: stringArrayField(body, "affectedComponentIds")! }
        : {}),
      ...(stringField(body, "areaId", false) ? { areaId: body.areaId as string } : {}),
      type: enumField(body, "type", WORK_ITEM_TYPES)!,
      priority: enumField(body, "priority", WORK_ITEM_PRIORITIES)!,
      title: stringField(body, "title")!,
      description: stringField(body, "description")!,
      ...(body.report !== undefined ? { report: workItemReportBody(body.report)! } : {}),
      ...(environment ? { environment } : {}),
      ...(sessionUser(request) ? { attribution: { accountId: sessionUser(request)!.id } } : {}),
    });
    return reply.status(201).send(item);
  });

  app.get("/api/v1/items/:itemKey", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    return withCreatorNames([store.getWorkItem(requireItemPermission(request, itemKey))])[0];
  });

  app.patch("/api/v1/items/:itemKey", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    const body = objectBody(request.body);
    return store.updateWorkItem(requireItemPermission(request, itemKey, "operate"), {
      ...(stringField(body, "title", false) !== undefined ? { title: body.title as string } : {}),
      ...(stringField(body, "description", false) !== undefined ? { description: body.description as string } : {}),
      ...(body.report !== undefined ? { report: workItemReportBody(body.report)! } : {}),
      ...(body.type !== undefined ? { type: enumField(body, "type", WORK_ITEM_TYPES)! } : {}),
      ...(body.priority !== undefined ? { priority: enumField(body, "priority", WORK_ITEM_PRIORITIES)! } : {}),
      ...(body.sourceComponentId !== undefined
        ? { sourceComponentId: body.sourceComponentId === null ? null : stringField(body, "sourceComponentId", false)! }
        : {}),
      ...(body.environment !== undefined ? { environment: environmentBody(body.environment, true)! } : {}),
      ...(body.affectedComponentIds !== undefined
        ? { affectedComponentIds: stringArrayField(body, "affectedComponentIds")! }
        : {}),
      ...(sessionUser(request) ? { attribution: { accountId: sessionUser(request)!.id } } : {}),
    });
  });

  app.post("/api/v1/items/:itemKey/transitions", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    const body = objectBody(request.body);
    return store.transitionWorkItem({
      itemKey: requireItemPermission(request, itemKey, "operate"),
      to: enumField(body, "to", WORK_ITEM_STATUSES)!,
      actor: "human",
      reason: enumField(body, "reason", TRANSITION_REASONS)!,
      ...(stringField(body, "note", false) !== undefined ? { note: body.note as string } : {}),
      // Who moved it. With one account "a human did" was enough; with several it
      // is the difference between a timeline and a rumour.
      ...(sessionUser(request) ? { attribution: { accountId: sessionUser(request)!.id } } : {}),
    });
  });

  /**
   * Closing verification on several items at once (AND-66).
   *
   * Only the one edge, pending_verification -> done, because it is the one a
   * person repeats in bulk after checking a release: every other move is either
   * a judgement about one item or needs a note of its own. It stays a signed-in
   * person's action -- "only a person closes verification" holds here exactly as
   * it does on the single route, and MCP has no door to it.
   *
   * Each item stands alone. One that moved on in the meantime, or that this
   * account cannot operate, is reported and skipped; the others still close,
   * because refusing a whole release's worth of checks over one stale row would
   * only send the person back to do them one by one.
   */
  app.post("/api/v1/items/transitions", async (request) => {
    const body = objectBody(request.body);
    const accountId = requireAccountId(request);
    const itemKeys = stringArrayField(body, "itemKeys");
    if (!itemKeys || itemKeys.length === 0) throw invalidInput("itemKeys must be a non-empty array of work item keys.");
    if (itemKeys.length > BULK_TRANSITION_LIMIT) {
      throw invalidInput(`At most ${BULK_TRANSITION_LIMIT} items can be moved at once.`);
    }
    const to = enumField(body, "to", WORK_ITEM_STATUSES)!;
    const reason = enumField(body, "reason", TRANSITION_REASONS)!;
    if (to !== "done" || reason !== "verification_passed") {
      throw invalidInput("Only closing verification (to done, verification_passed) can be done in bulk.");
    }
    const uniqueKeys = [...new Set(itemKeys.map((key) => key.toUpperCase()))];
    const results = uniqueKeys.map((itemKey) => {
      try {
        store.transitionWorkItem({
          itemKey: requireItemPermission(request, itemKey, "operate"),
          to,
          actor: "human",
          reason,
          attribution: { accountId },
        });
        return { itemKey, ok: true as const };
      } catch (error) {
        if (!(error instanceof MissionGoError)) throw error;
        return { itemKey, ok: false as const, code: error.code, message: error.message };
      }
    });
    return { results };
  });

  // A comment records the signed OAuth client id it was written through, and
  // that id carries the client's registered name. Decoding it here turns a
  // byline that only said "AI" into the program that actually wrote it, for
  // every comment ever written and without storing anything new.
  const withClientName = <T extends { readonly clientId?: string }>(entry: T): T & { clientName?: string } => {
    const name = entry.clientId ? oauthProvider?.clientDisplayName(entry.clientId) : undefined;
    return name ? { ...entry, clientName: name } : entry;
  };

  /**
   * The same for the person behind an entry.
   *
   * Events have carried an account id since accounts became plural, and nothing
   * had ever turned it into a name -- so everything a person wrote was signed
   * "human" and a timeline could not say who did what. Resolved on read rather
   * than stored, so a nickname changed today renames what its owner wrote last
   * month.
   *
   * Takes the whole list rather than one entry, unlike withClientName: the ids
   * are looked up in a single query, where one call per row would be a statement
   * per timeline event.
   */
  const withAuthorNames = <T extends { readonly accountId?: string; readonly clientId?: string }>(
    entries: readonly T[],
  ): Array<T & { clientName?: string; accountName?: string }> => {
    const names = accountStore.displayNames(
      entries.map((entry) => entry.accountId).filter((id): id is string => !!id),
    );
    return entries.map((entry) => {
      const decorated = withClientName(entry);
      const name = entry.accountId ? names.get(entry.accountId) : undefined;
      return name ? { ...decorated, accountName: name } : decorated;
    });
  };

  /**
   * The same names on an item's creator (AND-67): a person's nickname, or the
   * AI client's registered name. Resolved on read like the timeline's, so the
   * list follows a renamed account. An SDK creator is already named by its token.
   */
  function withCreatorNames<T extends { readonly createdBy?: WorkItemCreator }>(items: readonly T[]): T[] {
    const names = accountStore.displayNames(
      items.flatMap((item) => (item.createdBy?.kind === "human" ? [item.createdBy.accountId] : [])),
    );
    return items.map((item) => {
      const creator = item.createdBy;
      if (creator?.kind === "human") {
        const name = names.get(creator.accountId);
        return name ? { ...item, createdBy: { ...creator, name } } : item;
      }
      if (creator?.kind === "agent" && creator.clientId) {
        const { clientName } = withClientName({ clientId: creator.clientId });
        return clientName ? { ...item, createdBy: { ...creator, clientName } } : item;
      }
      return item;
    });
  }

  app.get("/api/v1/items/:itemKey/timeline", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    // The web folds withdrawn comments rather than hiding them, so a reader can
    // see that something was said and taken back. MCP gets the pruned view.
    const key = requireItemPermission(request, itemKey);
    return { events: withAuthorNames(store.getTimeline(key, { includeWithdrawn: true })) };
  });

  app.get("/api/v1/items/:itemKey/comments", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    const key = requireItemPermission(request, itemKey);
    return { comments: withAuthorNames(store.listComments(key, { includeWithdrawn: true })) };
  });

  app.post("/api/v1/items/:itemKey/comments", async (request, reply) => {
    const { itemKey } = request.params as { itemKey: string };
    const body = objectBody(request.body);
    const bodyKind = body.bodyKind === undefined ? "free" : enumField(body, "bodyKind", COMMENT_BODY_KINDS)!;
    const comment = store.createComment({
      itemKey: requireItemPermission(request, itemKey, "operate"),
      actorKind: "human",
      bodyKind,
      body: bodyKind === "free"
        ? { text: stringField(body, "text")! }
        : {
          understanding: stringField(body, "understanding")!,
          finding: stringField(body, "finding")!,
          evidence: stringArrayField(body, "evidence") ?? [],
          ...(stringField(body, "proposal", false) !== undefined ? { proposal: body.proposal as string } : {}),
          openQuestions: stringArrayField(body, "openQuestions") ?? [],
        },
      ...(stringField(body, "summary", false) !== undefined ? { summary: body.summary as string } : {}),
      ...(sessionUser(request) ? { attribution: { accountId: sessionUser(request)!.id } } : {}),
    });
    return reply.status(201).send(withAuthorNames([comment])[0]);
  });

  app.post("/api/v1/items/:itemKey/comments/:commentId/withdraw", async (request) => {
    const { itemKey, commentId } = request.params as { itemKey: string; commentId: string };
    return store.withdrawComment({
      itemKey: requireItemPermission(request, itemKey, "operate"),
      commentId,
      ...(sessionUser(request) ? { accountId: sessionUser(request)!.id } : {}),
    });
  });

  app.post("/api/v1/items/:itemKey/attachments", async (request, reply) => {
    const { itemKey } = request.params as { itemKey: string };
    const key = requireItemPermission(request, itemKey, "operate");
    if (!Buffer.isBuffer(request.body)) throw invalidInput("Attachment body must be binary data.");
    const filename = headerText(request.headers["x-missiongo-filename"], "X-MissionGo-Filename");
    const contentType = headerText(request.headers["x-missiongo-content-type"], "X-MissionGo-Content-Type");
    const attachment = await attachmentStorage.save(
      store, key, filename, contentType, request.body, undefined,
      sessionUser(request) ? { accountId: sessionUser(request)!.id } : undefined,
    );
    return reply.status(201).send(publicAttachment(attachment));
  });

  app.get("/api/v1/items/:itemKey/attachments", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    const key = requireItemPermission(request, itemKey);
    return { attachments: store.listAttachments(key).map(publicAttachment) };
  });

  app.get("/api/v1/items/:itemKey/attachments/:attachmentId/content", async (request, reply) => {
    const { itemKey, attachmentId } = request.params as { itemKey: string; attachmentId: string };
    const attachment = store.getAttachmentRecord(requireItemPermission(request, itemKey), attachmentId);
    const path = attachmentStorage.resolveStoredFile(attachment.storageFilename);
    const details = await stat(path);
    const disposition = attachment.kind === "log" ? "attachment" : "inline";
    const encodedFilename = encodeURIComponent(attachment.filename).replaceAll("'", "%27");
    const rangeHeader = request.headers.range;
    const range = rangeHeader ? requestedByteRange(rangeHeader, details.size) : undefined;
    if (rangeHeader && !range) {
      return reply
        .status(416)
        .header("content-range", `bytes */${details.size}`)
        .header("accept-ranges", "bytes")
        .send();
    }
    const contentLength = range ? range.end - range.start + 1 : details.size;
    reply
      .status(range ? 206 : 200)
      .type(attachment.contentType)
      .header("content-length", contentLength)
      .header("content-disposition", `${disposition}; filename*=UTF-8''${encodedFilename}`)
      .header("cache-control", "private, no-store")
      .header("accept-ranges", "bytes")
      .header("x-content-type-options", "nosniff");
    if (range) reply.header("content-range", `bytes ${range.start}-${range.end}/${details.size}`);
    return reply.send(createReadStream(path, range));
  });

  // The list and the detail view show thumbnails, and serving the original for
  // each one meant pushing megabytes to draw a small preview. Rendered on demand
  // rather than at upload time so it also covers everything already stored.
  //
  // Annotating replaces the bytes under the same attachment id, so the id alone
  // does not pin the content. Clients put the attachment's `revision` in the
  // query string; a replacement changes it, the URL changes with it, and that is
  // what lets the response be cached as immutable. A request without one still
  // works but only gets a short cache.
  app.get("/api/v1/items/:itemKey/attachments/:attachmentId/thumbnail", async (request, reply) => {
    const { itemKey, attachmentId } = request.params as { itemKey: string; attachmentId: string };
    const attachment = store.getAttachmentRecord(requireItemPermission(request, itemKey), attachmentId);
    if (attachment.kind !== "image") throw invalidInput("Only image attachments have thumbnails.");
    const query = request.query as { width?: string; rev?: string };
    const requested = Number(query.width);
    const width = Number.isFinite(requested)
      ? Math.min(Math.max(Math.round(requested), 32), MAX_THUMBNAIL_EDGE)
      : DEFAULT_THUMBNAIL_EDGE;
    const path = attachmentStorage.resolveStoredFile(attachment.storageFilename);
    const thumbnail = await sharp(await readFile(path), { animated: false })
      // Phone screenshots carry their orientation in EXIF; without this the
      // tile comes out on its side.
      .rotate()
      .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer();
    // Only a URL naming the current revision may be cached for good; an old
    // revision would otherwise pin the pre-edit bytes under a URL that looks
    // current to whoever still holds it.
    const pinned = query.rev !== undefined && query.rev === attachment.revision;
    return reply
      .type("image/jpeg")
      .header("content-length", thumbnail.length)
      .header("cache-control", pinned ? "private, max-age=2592000, immutable" : "private, no-cache")
      .header("x-content-type-options", "nosniff")
      .send(thumbnail);
  });

  // Editing an image in the browser sends the result back here rather than
  // deleting and re-uploading, so the attachment keeps the id and number that
  // the item detail view and the MCP item context already refer to.
  app.put("/api/v1/items/:itemKey/attachments/:attachmentId/content", async (request) => {
    const { itemKey, attachmentId } = request.params as { itemKey: string; attachmentId: string };
    const key = requireItemPermission(request, itemKey, "operate");
    if (!Buffer.isBuffer(request.body)) throw invalidInput("Attachment body must be binary data.");
    const filename = headerText(request.headers["x-missiongo-filename"], "X-MissionGo-Filename");
    const contentType = headerText(request.headers["x-missiongo-content-type"], "X-MissionGo-Content-Type");
    const attachment = await attachmentStorage.replace(
      store, key, attachmentId, filename, contentType, request.body,
      sessionUser(request) ? { accountId: sessionUser(request)!.id } : undefined,
    );
    return publicAttachment(attachment);
  });

  app.delete("/api/v1/items/:itemKey/attachments/:attachmentId", async (request, reply) => {
    const { itemKey, attachmentId } = request.params as { itemKey: string; attachmentId: string };
    await attachmentStorage.remove(
      store, requireItemPermission(request, itemKey, "operate"), attachmentId,
      sessionUser(request) ? { accountId: sessionUser(request)!.id } : undefined,
    );
    return reply.status(204).send();
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    missionGoStore: MissionGoStore;
    missionGoAccounts: AccountStore;
  }
}
