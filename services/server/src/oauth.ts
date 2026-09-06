import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  AI_ACCESS_SESSION_SECONDS,
  createAiAccessToken,
  type AdminAccountConfig,
  type AiAccessPrincipal,
} from "./admin-auth.js";

const AUTHORIZATION_REQUEST_SECONDS = 10 * 60;
const AUTHORIZATION_CODE_SECONDS = 5 * 60;
export const MISSIONGO_READ_SCOPE = "missiongo:read";
export const MISSIONGO_WRITE_SCOPE = "missiongo:write";
export const MISSIONGO_SUPPORTED_SCOPES = [MISSIONGO_READ_SCOPE, MISSIONGO_WRITE_SCOPE] as const;

/**
 * Normalize a requested scope string, or throw.
 *
 * Reading is always included: an agent that writes to a work item has to have
 * read it first, and a token that could write what it cannot read would be a
 * way to touch items outside the account's product scope.
 */
export function parseRequestedScopes(raw: string | undefined): readonly string[] {
  const requested = (raw ?? "").split(/\s+/).filter(Boolean);
  if (requested.some((scope) => !MISSIONGO_SUPPORTED_SCOPES.includes(scope as typeof MISSIONGO_SUPPORTED_SCOPES[number]))) {
    throw new Error("invalid_scope");
  }
  const granted = new Set(requested);
  granted.add(MISSIONGO_READ_SCOPE);
  return MISSIONGO_SUPPORTED_SCOPES.filter((scope) => granted.has(scope));
}

export interface RegisteredClient {
  readonly id: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
}

interface AuthorizationRequest {
  readonly version: 1;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state?: string;
  readonly scope: string;
  readonly codeChallenge: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

interface AuthorizationCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

interface ClientRegistrationPayload {
  readonly version: 1;
  readonly name: string;
  readonly redirectUris: readonly string[];
}

export interface OAuthAuthorizationInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly responseType: string;
  readonly state?: string;
  readonly scope?: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
}

export interface OAuthTokenResult {
  readonly accessToken: string;
  readonly principal: AiAccessPrincipal;
  readonly expiresIn: number;
  readonly scope: string;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function allowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function signedValue(payload: object, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function readSignedValue<T>(value: string, secret: string): T | undefined {
  const separator = value.indexOf(".");
  if (separator < 1 || value.indexOf(".", separator + 1) !== -1) return undefined;
  const encoded = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  if (!safeEqual(signature, expected)) return undefined;
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

export class MissionGoOAuthProvider {
  private readonly authorizationCodes = new Map<string, AuthorizationCode>();

  constructor(
    private readonly account: AdminAccountConfig,
    readonly publicOrigin: string,
  ) {}

  registerClient(input: {
    readonly clientName?: string;
    readonly redirectUris: readonly string[];
    readonly tokenEndpointAuthMethod?: string;
  }): RegisteredClient {
    if (
      input.redirectUris.length < 1
      || input.redirectUris.length > 10
      || input.redirectUris.some((uri) => !allowedRedirectUri(uri))
      || (input.tokenEndpointAuthMethod && input.tokenEndpointAuthMethod !== "none")
    ) throw new Error("invalid_client_metadata");
    const client: RegisteredClient = {
      id: "",
      name: input.clientName?.trim().slice(0, 120) || "AI client",
      redirectUris: [...new Set(input.redirectUris)],
    };
    return {
      ...client,
      id: `mgc_${signedValue({ version: 1, name: client.name, redirectUris: client.redirectUris }, this.account.sessionSecret)}`,
    };
  }

  private readClient(clientId: string): RegisteredClient | undefined {
    if (!clientId.startsWith("mgc_")) return undefined;
    const payload = readSignedValue<Partial<ClientRegistrationPayload>>(clientId.slice(4), this.account.sessionSecret);
    if (
      payload?.version !== 1
      || typeof payload.name !== "string"
      || !Array.isArray(payload.redirectUris)
      || payload.redirectUris.length < 1
      || payload.redirectUris.some((uri) => typeof uri !== "string" || !allowedRedirectUri(uri))
    ) return undefined;
    return { id: clientId, name: payload.name, redirectUris: payload.redirectUris };
  }

  beginAuthorization(
    input: OAuthAuthorizationInput,
    now = Date.now(),
  ): { requestToken: string; clientName: string; scopes: readonly string[] } {
    const client = this.readClient(input.clientId);
    const scopes = parseRequestedScopes(input.scope?.trim());
    if (
      !client
      || !client.redirectUris.includes(input.redirectUri)
      || input.responseType !== "code"
      || input.codeChallengeMethod !== "S256"
      || !/^[A-Za-z0-9_-]{43,128}$/.test(input.codeChallenge)
    ) throw new Error("invalid_authorization_request");
    const issuedAt = Math.floor(now / 1_000);
    const request: AuthorizationRequest = {
      version: 1,
      clientId: client.id,
      redirectUri: input.redirectUri,
      ...(input.state ? { state: input.state } : {}),
      scope: scopes.join(" "),
      codeChallenge: input.codeChallenge,
      issuedAt,
      expiresAt: issuedAt + AUTHORIZATION_REQUEST_SECONDS,
    };
    return { requestToken: signedValue(request, this.account.sessionSecret), clientName: client.name, scopes };
  }

  authorizationClientName(requestToken: string): string {
    const request = readSignedValue<Partial<AuthorizationRequest>>(requestToken, this.account.sessionSecret);
    return typeof request?.clientId === "string" ? this.readClient(request.clientId)?.name ?? "AI client" : "AI client";
  }

  /** Scopes a pending request asked for, so a re-rendered consent page still shows them. */
  authorizationScopes(requestToken: string): readonly string[] {
    const request = readSignedValue<Partial<AuthorizationRequest>>(requestToken, this.account.sessionSecret);
    try {
      return parseRequestedScopes(typeof request?.scope === "string" ? request.scope : undefined);
    } catch {
      return [MISSIONGO_READ_SCOPE];
    }
  }

  finishAuthorization(requestToken: string, now = Date.now()): { redirectUri: string; code: string; state?: string } {
    const request = readSignedValue<Partial<AuthorizationRequest>>(requestToken, this.account.sessionSecret);
    const nowSeconds = Math.floor(now / 1_000);
    if (
      request?.version !== 1
      || typeof request.clientId !== "string"
      || typeof request.redirectUri !== "string"
      || typeof request.codeChallenge !== "string"
      || typeof request.scope !== "string"
      || !Number.isSafeInteger(request.issuedAt)
      || !Number.isSafeInteger(request.expiresAt)
      || request.expiresAt! <= nowSeconds
      || request.issuedAt! > nowSeconds + 60
    ) throw new Error("invalid_authorization_request");
    const client = this.readClient(request.clientId);
    if (!client?.redirectUris.includes(request.redirectUri)) throw new Error("invalid_authorization_request");
    const scopes = parseRequestedScopes(request.scope);

    const code = randomBytes(32).toString("base64url");
    this.authorizationCodes.set(code, {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scopes,
      expiresAt: nowSeconds + AUTHORIZATION_CODE_SECONDS,
    });
    return {
      redirectUri: request.redirectUri,
      code,
      ...(typeof request.state === "string" ? { state: request.state } : {}),
    };
  }

  exchangeCode(input: {
    readonly grantType: string;
    readonly code: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
  }, now = Date.now()): OAuthTokenResult {
    const record = this.authorizationCodes.get(input.code);
    this.authorizationCodes.delete(input.code);
    const nowSeconds = Math.floor(now / 1_000);
    const calculatedChallenge = createHash("sha256").update(input.codeVerifier, "utf8").digest("base64url");
    if (
      input.grantType !== "authorization_code"
      || !record
      || record.expiresAt <= nowSeconds
      || record.clientId !== input.clientId
      || record.redirectUri !== input.redirectUri
      || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)
      || !safeEqual(calculatedChallenge, record.codeChallenge)
    ) throw new Error("invalid_grant");
    const issued = createAiAccessToken(this.account, input.clientId, record.scopes, now);
    return {
      accessToken: issued.token,
      principal: issued.principal,
      expiresIn: AI_ACCESS_SESSION_SECONDS,
      scope: record.scopes.join(" "),
    };
  }
}
