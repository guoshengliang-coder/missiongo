import { createHash, createSign } from "node:crypto";

import type { WidgetDeviceStore } from "./widget-devices.js";
import type { WidgetSummary } from "./widget-summary.js";

/** The parts of a logger the push path uses; Fastify's logger satisfies this. */
export interface WidgetPushLog {
  error(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
}

export interface WidgetPushServiceAccount {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKey: string;
}

/** Accepts the raw Firebase service-account JSON; anything missing means push stays off. */
export function parseWidgetPushServiceAccount(value: string | undefined): WidgetPushServiceAccount | undefined {
  if (!value?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("WIDGET_FCM_SERVICE_ACCOUNT must be the service-account JSON.");
  }
  const account = parsed as { project_id?: unknown; client_email?: unknown; private_key?: unknown };
  if (typeof account.project_id !== "string" || !account.project_id
    || typeof account.client_email !== "string" || !account.client_email
    || typeof account.private_key !== "string" || !account.private_key) {
    throw new Error("WIDGET_FCM_SERVICE_ACCOUNT must carry project_id, client_email, and private_key.");
  }
  return {
    projectId: account.project_id,
    clientEmail: account.client_email,
    privateKey: account.private_key,
  };
}

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const FCM_ENDPOINT = "https://fcm.googleapis.com/v1/projects";

/** A signal only: the app refetches /api/v1/widget/summary itself, so nothing about the account transits Google. */
const MESSAGE_DATA = { widget: "refresh" } as const;

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Service-account OAuth per RFC 7523: a self-signed RS256 JWT exchanged for an
 * access token. Node's crypto signs; no Google SDK on the server.
 */
async function fetchAccessToken(
  serviceAccount: WidgetPushServiceAccount,
  fetchImpl: typeof fetch,
): Promise<{ readonly token: string; readonly expiresAtMs: number }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: serviceAccount.clientEmail,
    scope: FCM_SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(serviceAccount.privateKey, "base64url");
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  if (!response.ok) {
    // The response body names the account or echoes the key; status is all a log needs.
    throw new Error(`widget push: token exchange failed (${response.status})`);
  }
  const granted = await response.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof granted.access_token !== "string" || !granted.access_token) {
    throw new Error("widget push: token exchange returned no access token");
  }
  const expiresIn = typeof granted.expires_in === "number" ? granted.expires_in : 3600;
  return { token: granted.access_token, expiresAtMs: Date.now() + expiresIn * 1000 };
}

/**
 * AND-150's server half: when something a widget shows may have changed,
 * recompute the summary and push a data-only FCM message -- but only when it
 * actually differs from what the account's devices were last told about.
 *
 * "May have changed" is deliberately cheap and broad: every caller-below routes
 * mutations through noteChanged(), and the fingerprint comparison below is what
 * keeps devices quiet. Bursts collapse into one push per debounce window.
 */
export class WidgetPushService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastPushed = new Map<string, string>();
  private cachedAccessToken: { readonly token: string; readonly expiresAtMs: number } | undefined;
  private inFlight: Promise<void> | undefined;
  private rerunAfterFlight = false;
  private closed = false;

  constructor(private readonly deps: {
    readonly devices: WidgetDeviceStore;
    /** The summary the /api/v1/widget/summary route would serve, or nothing when the account no longer resolves. */
    readonly summaryFor: (accountId: string) => WidgetSummary | undefined;
    readonly serviceAccount?: WidgetPushServiceAccount;
    readonly fetchImpl?: typeof fetch;
    readonly debounceMs?: number;
    readonly log?: WidgetPushLog;
  }) {}

  /** Anything that might change a widget's numbers calls this; most calls push nothing. */
  noteChanged(accountId?: string): void {
    // Without credentials there is nothing to send, and deployments that opt out
    // should not pay a device-table query on every mutation.
    if (this.closed || !this.deps.serviceAccount) return;
    const accounts = accountId
      ? (this.deps.devices.listForAccount(accountId).length > 0 ? [accountId] : [])
      : this.deps.devices.accountIds();
    for (const account of accounts) {
      const existing = this.timers.get(account);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.timers.delete(account);
        void this.evaluate(account);
      }, this.deps.debounceMs ?? 3_000);
      timer.unref?.();
      this.timers.set(account, timer);
    }
  }

  /** Stops scheduled pushes and waits for one already sending. Call from app close. */
  close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    return this.inFlight ?? Promise.resolve();
  }

  private async evaluate(accountId: string): Promise<void> {
    if (this.inFlight) {
      // A push is already comparing or sending; fold this evaluation into a rerun
      // afterwards rather than reading mid-flight state.
      this.rerunAfterFlight = true;
      return;
    }
    this.inFlight = this.runFor(accountId).finally(() => {
      this.inFlight = undefined;
      if (this.rerunAfterFlight && !this.closed) {
        this.rerunAfterFlight = false;
        this.noteChanged();
      }
    });
    await this.inFlight;
  }

  private async runFor(accountId: string): Promise<void> {
    if (!this.deps.serviceAccount) return;
    const tokens = this.deps.devices.listForAccount(accountId);
    if (tokens.length === 0) return;
    const summary = this.deps.summaryFor(accountId);
    if (!summary) return;
    const fingerprint = widgetSummaryFingerprint(summary);
    if (this.lastPushed.get(accountId) === fingerprint) return;
    const failed: string[] = [];
    for (const token of tokens) {
      try {
        await this.send(token);
      } catch (error) {
        if (error instanceof UnregisteredToken) {
          this.deps.devices.forget(token);
          this.deps.log?.info("widget push: dropped an unregistered FCM token");
          continue;
        }
        failed.push(token);
        this.deps.log?.error("widget push: delivery failed", error instanceof Error ? error.message : error);
      }
    }
    // A token that failed stays registered and hears about the next change; only
    // a clean sweep records the fingerprint so a partial failure retries.
    if (failed.length === 0) this.lastPushed.set(accountId, fingerprint);
  }

  private async send(token: string): Promise<void> {
    const serviceAccount = this.deps.serviceAccount!;
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    let accessToken = await this.accessToken(fetchImpl);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetchImpl(
        `${FCM_ENDPOINT}/${serviceAccount.projectId}/messages:send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token,
              data: { ...MESSAGE_DATA },
              android: { priority: "NORMAL" },
            },
          }),
        },
      );
      if (response.ok) return;
      if (response.status === 404 || response.status === 410) throw new UnregisteredToken();
      if (response.status === 401 && attempt === 0) {
        this.cachedAccessToken = undefined;
        accessToken = await this.accessToken(fetchImpl);
        continue;
      }
      throw new Error(`FCM responded ${response.status}`);
    }
    throw new Error("FCM rejected the access token twice");
  }

  private async accessToken(fetchImpl: typeof fetch): Promise<string> {
    if (this.cachedAccessToken && this.cachedAccessToken.expiresAtMs > Date.now() + 60_000) {
      return this.cachedAccessToken.token;
    }
    const granted = await fetchAccessToken(this.deps.serviceAccount!, fetchImpl);
    this.cachedAccessToken = granted;
    return granted.token;
  }
}

class UnregisteredToken extends Error {}

/** Everything a device can see, minus the timestamp that changes every read. */
export function widgetSummaryFingerprint(summary: WidgetSummary): string {
  const { generatedAt: _generatedAt, ...stable } = summary;
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
