import { createHmac, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

export interface AdminAccountConfig {
  readonly id: string;
  readonly username: string;
  readonly passwordScrypt: string;
  readonly sessionSecret: string;
  readonly cookieSecure: boolean;
  /** Product IDs this account can read through AI clients. Omit for all products. */
  readonly authorizedProductIds?: readonly string[];
}

export interface AdminSessionUser {
  readonly id: string;
  readonly username: string;
  readonly role: "admin";
}

interface SessionPayload extends AdminSessionUser {
  readonly version: 1;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface AiAccessPrincipal extends AdminSessionUser {
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly productIds: "*" | readonly string[];
  readonly expiresAt: number;
}

interface AiAccessPayload extends AiAccessPrincipal {
  readonly version: 1;
  readonly kind: "ai_access";
  readonly tokenId: string;
  readonly issuedAt: number;
}

export const ADMIN_SESSION_COOKIE = "missiongo_session";
export const ADMIN_SESSION_SECONDS = 30 * 24 * 60 * 60;
export const AI_ACCESS_SESSION_SECONDS = 30 * 24 * 60 * 60;

function safeEqualText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function passwordHashParts(value: string): { salt: Buffer; hash: Buffer } | undefined {
  const separator = value.includes(":") ? ":" : "$";
  const [algorithm, encodedSalt, encodedHash, ...rest] = value.split(separator);
  if (algorithm !== "scrypt" || !encodedSalt || !encodedHash || rest.length > 0) return undefined;
  try {
    const salt = Buffer.from(encodedSalt, "base64url");
    const hash = Buffer.from(encodedHash, "base64url");
    if (salt.length < 16 || hash.length !== 64) return undefined;
    return { salt, hash };
  } catch {
    return undefined;
  }
}

export function verifyAdminCredentials(config: AdminAccountConfig, username: string, password: string): boolean {
  const stored = passwordHashParts(config.passwordScrypt);
  if (!stored || password.length > 1_024 || username.length > 128) return false;
  const suppliedHash = scryptSync(password, stored.salt, stored.hash.length);
  return safeEqualText(username, config.username) && timingSafeEqual(suppliedHash, stored.hash);
}

function signPayload(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function readSignedPayload<T>(token: string, prefix: string, secret: string): T | undefined {
  if (!token.startsWith(prefix)) return undefined;
  const value = token.slice(prefix.length);
  const separator = value.indexOf(".");
  if (separator < 1 || value.indexOf(".", separator + 1) !== -1) return undefined;
  const encodedPayload = value.slice(0, separator);
  const suppliedSignature = value.slice(separator + 1);
  if (!safeEqualText(suppliedSignature, signPayload(encodedPayload, secret))) return undefined;
  try {
    return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

export function createAdminSession(config: AdminAccountConfig, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1_000);
  const payload: SessionPayload = {
    version: 1,
    id: config.id,
    username: config.username,
    role: "admin",
    issuedAt,
    expiresAt: issuedAt + ADMIN_SESSION_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${signPayload(encodedPayload, config.sessionSecret)}`;
}

export function readAdminSession(config: AdminAccountConfig, token: string, now = Date.now()): AdminSessionUser | undefined {
  const separator = token.indexOf(".");
  if (separator < 1 || token.indexOf(".", separator + 1) !== -1) return undefined;
  const encodedPayload = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  if (!safeEqualText(suppliedSignature, signPayload(encodedPayload, config.sessionSecret))) return undefined;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<SessionPayload>;
    const nowSeconds = Math.floor(now / 1_000);
    if (
      payload.version !== 1
      || payload.id !== config.id
      || payload.username !== config.username
      || payload.role !== "admin"
      || !Number.isSafeInteger(payload.issuedAt)
      || !Number.isSafeInteger(payload.expiresAt)
      || payload.expiresAt! <= nowSeconds
      || payload.issuedAt! > nowSeconds + 60
    ) return undefined;
    return { id: payload.id, username: payload.username, role: "admin" };
  } catch {
    return undefined;
  }
}

export function createAiAccessToken(
  config: AdminAccountConfig,
  clientId: string,
  scopes: readonly string[] = ["missiongo:read"],
  now = Date.now(),
): { token: string; principal: AiAccessPrincipal } {
  const issuedAt = Math.floor(now / 1_000);
  const payload: AiAccessPayload = {
    version: 1,
    kind: "ai_access",
    tokenId: randomUUID(),
    id: config.id,
    username: config.username,
    role: "admin",
    clientId,
    scopes: [...scopes],
    productIds: config.authorizedProductIds ? [...new Set(config.authorizedProductIds)] : "*",
    issuedAt,
    expiresAt: issuedAt + AI_ACCESS_SESSION_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    token: `mgai_${encodedPayload}.${signPayload(encodedPayload, config.sessionSecret)}`,
    principal: payload,
  };
}

export function readAiAccessToken(
  config: AdminAccountConfig,
  token: string,
  now = Date.now(),
): AiAccessPrincipal | undefined {
  const payload = readSignedPayload<Partial<AiAccessPayload>>(token, "mgai_", config.sessionSecret);
  const nowSeconds = Math.floor(now / 1_000);
  if (
    payload?.version !== 1
    || payload.kind !== "ai_access"
    || payload.id !== config.id
    || payload.username !== config.username
    || payload.role !== "admin"
    || typeof payload.clientId !== "string"
    || !payload.clientId
    || !Array.isArray(payload.scopes)
    || payload.scopes.some((scope) => typeof scope !== "string")
    || (payload.productIds !== "*" && (!Array.isArray(payload.productIds) || payload.productIds.some((id) => typeof id !== "string")))
    || !Number.isSafeInteger(payload.issuedAt)
    || !Number.isSafeInteger(payload.expiresAt)
    || payload.expiresAt! <= nowSeconds
    || payload.issuedAt! > nowSeconds + 60
  ) return undefined;
  return {
    id: payload.id,
    username: payload.username,
    role: "admin",
    clientId: payload.clientId,
    scopes: payload.scopes,
    productIds: config.authorizedProductIds ? [...new Set(config.authorizedProductIds)] : "*",
    expiresAt: payload.expiresAt!,
  };
}

export function adminSessionCookie(config: AdminAccountConfig, token: string): string {
  return [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${ADMIN_SESSION_SECONDS}`,
    ...(config.cookieSecure ? ["Secure"] : []),
  ].join("; ");
}

export function expiredAdminSessionCookie(config: AdminAccountConfig): string {
  return [
    `${ADMIN_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    ...(config.cookieSecure ? ["Secure"] : []),
  ].join("; ");
}
