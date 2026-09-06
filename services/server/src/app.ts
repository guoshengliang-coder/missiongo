import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";

import {
  TRANSITION_REASONS,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
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
  verifyAdminCredentials,
  type AdminAccountConfig,
  type AdminSessionUser,
} from "./admin-auth.js";
import { AttachmentStorage, MAX_ATTACHMENT_BYTES } from "./attachment-storage.js";
import { invalidInput, MissionGoError } from "./errors.js";
import { createMissionGoMcpHandler } from "./mcp.js";
import { MISSIONGO_READ_SCOPE, MissionGoOAuthProvider, type OAuthAuthorizationInput } from "./oauth.js";
import { MissionGoStore } from "./store.js";
import { COMPONENT_KINDS, type ComponentKind } from "./types.js";
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
}

type SdkRateLimitBucket = "draft_read" | "draft_write" | "finalize" | "web_session" | "attachment_upload";
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
};

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

function oauthLoginPage(clientName: string, requestToken: string, invalidCredentials = false): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>连接 MissionGo</title>
  <link rel="stylesheet" href="/oauth/login.css">
</head>
<body><main class="card">
  <div class="mark">🚀</div><p class="eyebrow">AI 读取授权</p><h1 class="title">连接 MissionGo</h1>
  <p class="copy"><span class="client">${escapedHtml(clientName)}</span> 请求读取你有权限查看的 MissionGo 内容。首次连接请验证账号。</p>
  ${invalidCredentials ? '<p class="error">用户名或密码不正确，请重新输入。</p>' : ""}
  <form method="post" action="/oauth/authorize">
    <input type="hidden" name="request" value="${escapedHtml(requestToken)}">
    <label for="username">用户名</label><input id="username" name="username" autocomplete="username" required autofocus>
    <label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">确认并连接</button>
  </form>
  <p class="note">密码只用于本次验证，不会交给 AI。服务端会签发限时读取授权，并在每次读取时校验账号权限。</p>
</main></body></html>`;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, trustProxy: options.trustProxy ?? false });
  const store = new MissionGoStore(options.databasePath ?? ":memory:");
  const attachmentStorage = new AttachmentStorage(options.attachmentsPath ?? "./data/attachments");
  const publicOrigin = new URL(options.publicOrigin ?? "http://127.0.0.1").origin;
  const mcpHandler = options.adminAccount
    // Only hand out an update URL when a real deployment origin was configured;
    // the loopback fallback above is not an address a client can reinstall from.
    ? createMissionGoMcpHandler(store, attachmentStorage, options.publicOrigin ? { publicOrigin } : {})
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

  const sessionUser = (request: FastifyRequest): AdminSessionUser | undefined => options.adminAccount
    ? readAdminSession(options.adminAccount, cookieValue(request, ADMIN_SESSION_COOKIE))
    : undefined;

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
      || (!options.adminToken && !options.adminAccount)
    ) return;
    const bearerAuthorized = options.adminToken
      ? hasBearerToken(request.headers.authorization, options.adminToken)
      : false;
    if (!bearerAuthorized && !sessionUser(request)) {
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

  app.get("/health", async () => ({ status: "ok" }));

  if (oauthProvider && options.adminAccount) {
    app.get("/oauth/login.css", async (_request, reply) => reply
      .header("cache-control", "public, max-age=3600")
      .type("text/css; charset=utf-8")
      .send(`*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f3ed;color:#172033;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;padding:20px}.card{width:min(100%,440px);background:#fff;border:1px solid #dedbd2;border-radius:24px;padding:32px;box-shadow:0 20px 55px rgba(23,32,51,.12)}.mark{display:grid;place-items:center;width:54px;height:54px;border-radius:17px;background:#61dfb3;font-size:27px}.eyebrow{margin:24px 0 8px;color:#72798a;font-size:13px;font-weight:700}.title{margin:0;font-size:30px;line-height:1.15}.copy{color:#697183;line-height:1.65}.client{font-weight:700;color:#172033}.error{padding:11px 13px;border-radius:12px;background:#fff0f0;color:#ad2e2e;font-size:14px}label{display:block;margin:18px 0 7px;font-size:14px;font-weight:700}input{width:100%;height:48px;border:1px solid #cbc8c0;border-radius:12px;padding:0 13px;font:inherit}button{width:100%;height:50px;margin-top:24px;border:0;border-radius:13px;background:#172033;color:#fff;font:inherit;font-weight:750;cursor:pointer}.note{margin:16px 0 0;color:#7a8190;font-size:12px;line-height:1.55}@media(max-width:520px){.card{padding:24px;border-radius:20px}.title{font-size:27px}}`));

    app.get("/.well-known/oauth-protected-resource/mcp", async (_request, reply) => reply
      .header("cache-control", "public, max-age=300")
      .send({
        resource: `${publicOrigin}/mcp`,
        authorization_servers: [publicOrigin],
        scopes_supported: [MISSIONGO_READ_SCOPE],
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
        scopes_supported: [MISSIONGO_READ_SCOPE],
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
          oauthLoginPage(started.clientName, started.requestToken),
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
      if (!verifyAdminCredentials(options.adminAccount!, username, password)) {
        recordLoginFailure(request, now);
        return reply.header("cache-control", "no-store").type("text/html; charset=utf-8").status(401).send(
          oauthLoginPage(oauthProvider.authorizationClientName(requestToken), requestToken, true),
        );
      }
      loginFailures.delete(request.ip);
      try {
        const completed = oauthProvider.finishAuthorization(requestToken);
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
        return reply.header("cache-control", "no-store").send({
          access_token: issued.accessToken,
          token_type: "Bearer",
          expires_in: issued.expiresIn,
          scope: MISSIONGO_READ_SCOPE,
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
        user: { id: "local-admin", username: "local-admin", role: "admin" },
      });
    }
    const user = sessionUser(request);
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
    if (!verifyAdminCredentials(options.adminAccount, username, password)) {
      recordLoginFailure(request, now);
      return reply.header("cache-control", "no-store").status(401).send({
        type: "urn:missiongo:problem:invalid_credentials",
        title: "The username or password is incorrect.",
        status: 401,
        code: "invalid_credentials",
      });
    }

    loginFailures.delete(request.ip);
    const token = createAdminSession(options.adminAccount, now);
    return reply
      .header("cache-control", "no-store")
      .header("set-cookie", adminSessionCookie(options.adminAccount, token))
      .send({ user: { id: options.adminAccount.id, username: options.adminAccount.username, role: "admin" } });
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
        const principal = readAiAccessToken(options.adminAccount!, token);
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

  app.get("/api/v1/products", async (request) =>
    store.listProducts({ includeArchived: includeArchived(request.query) }));

  app.get("/api/v1/sdk-tokens", async () => store.listSdkTokens());

  app.post("/api/v1/sdk-tokens", async (request, reply) => {
    const body = objectBody(request.body);
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
    return store.finalizeFeedbackDraft(draftId, principal, status);
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

  app.post("/api/v1/products", async (request, reply) => {
    const body = objectBody(request.body);
    const product = store.createProduct({
      name: stringField(body, "name")!,
      keyPrefix: stringField(body, "keyPrefix")!,
    });
    return reply.status(201).send(product);
  });

  app.patch("/api/v1/products/:productId", async (request) => {
    const { productId } = request.params as { productId: string };
    const body = objectBody(request.body);
    return store.updateProduct(productId, {
      ...(body.name !== undefined ? { name: stringField(body, "name")! } : {}),
      ...(body.archived !== undefined ? { archived: booleanField(body, "archived") } : {}),
    });
  });

  app.get("/api/v1/products/:productId/components", async (request) => {
    const { productId } = request.params as { productId: string };
    return store.listComponents(productId, { includeArchived: includeArchived(request.query) });
  });

  app.post("/api/v1/products/:productId/components", async (request, reply) => {
    const { productId } = request.params as { productId: string };
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
    const body = objectBody(request.body);
    return store.updateComponent(productId, componentId, {
      ...(body.name !== undefined ? { name: stringField(body, "name")! } : {}),
      ...(body.kind !== undefined ? { kind: enumField(body, "kind", COMPONENT_KINDS)! as ComponentKind } : {}),
      ...(body.archived !== undefined ? { archived: booleanField(body, "archived") } : {}),
    });
  });

  app.get("/api/v1/items", async (request) => {
    const query = request.query as Record<string, unknown>;
    const productId = typeof query.productId === "string" ? query.productId : undefined;
    if (!productId) throw invalidInput("productId is required.");
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
      items,
      summary: store.getWorkItemListSummary({
        productId,
        ...(typeof query.type === "string" ? { type: query.type as never } : {}),
        ...(typeof query.search === "string" ? { search: query.search } : {}),
      }),
      ...(nextBeforeSequence !== undefined ? { nextBeforeSequence } : {}),
    };
  });

  app.post("/api/v1/items", async (request, reply) => {
    const body = objectBody(request.body);
    const environment = environmentBody(body.environment);
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
    });
    return reply.status(201).send(item);
  });

  app.get("/api/v1/items/:itemKey", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    return store.getWorkItem(itemKey);
  });

  app.patch("/api/v1/items/:itemKey", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    const body = objectBody(request.body);
    return store.updateWorkItem(itemKey, {
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
    });
  });

  app.post("/api/v1/items/:itemKey/transitions", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    const body = objectBody(request.body);
    return store.transitionWorkItem({
      itemKey,
      to: enumField(body, "to", WORK_ITEM_STATUSES)!,
      actor: "human",
      reason: enumField(body, "reason", TRANSITION_REASONS)!,
      ...(stringField(body, "note", false) !== undefined ? { note: body.note as string } : {}),
    });
  });

  app.get("/api/v1/items/:itemKey/timeline", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    return { events: store.getTimeline(itemKey) };
  });

  app.post("/api/v1/items/:itemKey/attachments", async (request, reply) => {
    const { itemKey } = request.params as { itemKey: string };
    if (!Buffer.isBuffer(request.body)) throw invalidInput("Attachment body must be binary data.");
    const filename = headerText(request.headers["x-missiongo-filename"], "X-MissionGo-Filename");
    const contentType = headerText(request.headers["x-missiongo-content-type"], "X-MissionGo-Content-Type");
    const attachment = await attachmentStorage.save(store, itemKey, filename, contentType, request.body);
    return reply.status(201).send(publicAttachment(attachment));
  });

  app.get("/api/v1/items/:itemKey/attachments", async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    return { attachments: store.listAttachments(itemKey).map(publicAttachment) };
  });

  app.get("/api/v1/items/:itemKey/attachments/:attachmentId/content", async (request, reply) => {
    const { itemKey, attachmentId } = request.params as { itemKey: string; attachmentId: string };
    const attachment = store.getAttachmentRecord(itemKey, attachmentId);
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

  // Editing an image in the browser sends the result back here rather than
  // deleting and re-uploading, so the attachment keeps the id and number that
  // the item detail view and the MCP item context already refer to.
  app.put("/api/v1/items/:itemKey/attachments/:attachmentId/content", async (request) => {
    const { itemKey, attachmentId } = request.params as { itemKey: string; attachmentId: string };
    if (!Buffer.isBuffer(request.body)) throw invalidInput("Attachment body must be binary data.");
    const filename = headerText(request.headers["x-missiongo-filename"], "X-MissionGo-Filename");
    const contentType = headerText(request.headers["x-missiongo-content-type"], "X-MissionGo-Content-Type");
    const attachment = await attachmentStorage.replace(store, itemKey, attachmentId, filename, contentType, request.body);
    return publicAttachment(attachment);
  });

  app.delete("/api/v1/items/:itemKey/attachments/:attachmentId", async (request, reply) => {
    const { itemKey, attachmentId } = request.params as { itemKey: string; attachmentId: string };
    await attachmentStorage.remove(store, itemKey, attachmentId);
    return reply.status(204).send();
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    missionGoStore: MissionGoStore;
  }
}
