import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * The deployment's signing secrets and the account it starts life with.
 *
 * Accounts live in the database (AND-33); what stays here is what a database
 * cannot supply. `sessionSecret` and `cookieSecure` belong to the deployment.
 * The id, username, password hash and authorized product ids describe the
 * administrator to create on a database that has none -- read once, at startup,
 * by AccountStore.seedBootstrapAdmin, and never consulted again afterwards.
 */
export interface AdminAccountConfig {
  readonly id: string;
  readonly username: string;
  readonly passwordScrypt: string;
  readonly sessionSecret: string;
  readonly cookieSecure: boolean;
  /** Product IDs the initial account can read through AI clients. Omit for all products. */
  readonly authorizedProductIds?: readonly string[];
}

export type AccountRole = "admin" | "member";

export interface AdminSessionUser {
  readonly id: string;
  readonly username: string;
  readonly role: AccountRole;
}

interface SessionPayload extends AdminSessionUser {
  readonly version: 1;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/**
 * A verified session cookie.
 *
 * `issuedAt` is carried out of the payload deliberately: the signature proves
 * the server minted this, and nothing more. Whether the account still exists,
 * is still enabled, and has not changed its password since is a question for
 * the accounts table, and it needs to know when this was issued to answer it.
 */
export interface AdminSessionClaims extends AdminSessionUser {
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface AiAccessPrincipal extends AdminSessionUser {
  readonly clientId: string;
  readonly scopes: readonly string[];
  /**
   * Which products this authorization reaches. Resolved from the account's
   * permissions at every use rather than frozen into the token, so revoking a
   * product takes effect on the next request instead of in thirty days.
   */
  readonly productIds: "*" | readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
}

interface AiAccessPayload extends AdminSessionUser {
  readonly version: 1;
  readonly kind: "ai_access";
  readonly tokenId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** A verified AI token, before its product reach has been looked up. */
export type AiAccessClaims = Omit<AiAccessPrincipal, "productIds">;

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

/** Check a password against a stored `scrypt:salt:hash` string. */
export function verifyPassword(passwordScrypt: string, password: string): boolean {
  const stored = passwordHashParts(passwordScrypt);
  if (!stored || password.length > 1_024) return false;
  const suppliedHash = scryptSync(password, stored.salt, stored.hash.length);
  return timingSafeEqual(suppliedHash, stored.hash);
}

/**
 * Hash a password into the same `scrypt:salt:hash` string the environment
 * variable carries, so a hash produced by `npm run admin:hash-password` and one
 * produced here are the same kind of thing.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`;
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

export function createAdminSession(config: AdminAccountConfig, user: AdminSessionUser, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1_000);
  const payload: SessionPayload = {
    version: 1,
    id: user.id,
    username: user.username,
    role: user.role,
    issuedAt,
    expiresAt: issuedAt + ADMIN_SESSION_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${signPayload(encodedPayload, config.sessionSecret)}`;
}

/**
 * Verify a session cookie's signature, shape and expiry.
 *
 * This says the cookie is genuine and unexpired, not that the account behind it
 * is still allowed in. The caller resolves the id against the accounts table --
 * with `issuedAt`, so a password changed after the cookie was minted refuses it.
 */
export function readAdminSession(config: AdminAccountConfig, token: string, now = Date.now()): AdminSessionClaims | undefined {
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
      || typeof payload.id !== "string"
      || !payload.id
      || typeof payload.username !== "string"
      || !payload.username
      || (payload.role !== "admin" && payload.role !== "member")
      || !Number.isSafeInteger(payload.issuedAt)
      || !Number.isSafeInteger(payload.expiresAt)
      || payload.expiresAt! <= nowSeconds
      || payload.issuedAt! > nowSeconds + 60
    ) return undefined;
    return {
      id: payload.id,
      username: payload.username,
      role: payload.role,
      issuedAt: payload.issuedAt!,
      expiresAt: payload.expiresAt!,
    };
  } catch {
    return undefined;
  }
}

export function createAiAccessToken(
  config: AdminAccountConfig,
  user: AdminSessionUser,
  clientId: string,
  scopes: readonly string[] = ["missiongo:read"],
  now = Date.now(),
): { token: string; claims: AiAccessClaims } {
  const issuedAt = Math.floor(now / 1_000);
  const payload: AiAccessPayload = {
    version: 1,
    kind: "ai_access",
    tokenId: randomUUID(),
    id: user.id,
    username: user.username,
    role: user.role,
    clientId,
    scopes: [...scopes],
    issuedAt,
    expiresAt: issuedAt + AI_ACCESS_SESSION_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const { version: _version, kind: _kind, tokenId: _tokenId, ...claims } = payload;
  return {
    token: `mgai_${encodedPayload}.${signPayload(encodedPayload, config.sessionSecret)}`,
    claims,
  };
}

/**
 * Verify an AI token's signature, shape and expiry.
 *
 * No product list comes back: which products the authorization reaches is the
 * account's current permission set, looked up by the caller. Keeping it out of
 * the token is what makes "untick a product and the AI loses it now" true
 * rather than true in thirty days.
 */
export function readAiAccessToken(
  config: AdminAccountConfig,
  token: string,
  now = Date.now(),
): AiAccessClaims | undefined {
  const payload = readSignedPayload<Partial<AiAccessPayload>>(token, "mgai_", config.sessionSecret);
  const nowSeconds = Math.floor(now / 1_000);
  if (
    payload?.version !== 1
    || payload.kind !== "ai_access"
    || typeof payload.id !== "string"
    || !payload.id
    || typeof payload.username !== "string"
    || !payload.username
    || (payload.role !== "admin" && payload.role !== "member")
    || typeof payload.clientId !== "string"
    || !payload.clientId
    || !Array.isArray(payload.scopes)
    || payload.scopes.some((scope) => typeof scope !== "string")
    || !Number.isSafeInteger(payload.issuedAt)
    || !Number.isSafeInteger(payload.expiresAt)
    || payload.expiresAt! <= nowSeconds
    || payload.issuedAt! > nowSeconds + 60
  ) return undefined;
  return {
    id: payload.id,
    username: payload.username,
    role: payload.role,
    clientId: payload.clientId,
    scopes: payload.scopes,
    issuedAt: payload.issuedAt!,
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
