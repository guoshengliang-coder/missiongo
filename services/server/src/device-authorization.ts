import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import type { AdminSessionUser } from "./admin-auth.js";
import type { MissionGoDatabase } from "./storage/database.js";

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const LIFETIME_MS = 10 * 60_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const normalizeCode = (value: string) => value.toUpperCase().replace(/[ -]/g, "");

export class DeviceGrantError extends Error {}

export interface DeviceRequest {
  readonly device_hash: string;
  readonly client_id: string;
  readonly user_hash: string;
  readonly consent_proof: string;
  readonly scopes_json: string;
  readonly expires_at: number;
  readonly interval_ms: number;
  readonly next_poll_at: number;
  readonly status: "pending" | "approved" | "denied" | "consumed";
  readonly user_json: string | null;
  readonly credentials_at: number | null;
}

/** Durable, one-use requests. Neither short codes nor bearer device codes are stored. */
export class DeviceAuthorizationStore {
  constructor(private readonly database: MissionGoDatabase) {}

  begin(clientId: string, scopes: readonly string[], origin: string, now = Date.now()) {
    this.database.connection.prepare("DELETE FROM oauth_device_requests WHERE expires_at < ?").run(now - 24 * 60 * 60_000);
    const count = this.database.connection.prepare("SELECT count(*) AS count FROM oauth_device_requests WHERE expires_at > ?")
      .get(now) as unknown as { count: number };
    if (count.count >= 10_000) throw new DeviceGrantError("temporarily_unavailable");
    const deviceCode = randomBytes(32).toString("base64url");
    // Ten unambiguous, uniformly random characters. Verification is rate limited.
    const alphabet = "BCDFGHJKLMNPQRSTVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 10; i++) code += alphabet[randomInt(alphabet.length)];
    const userCode = `${code.slice(0, 5)}-${code.slice(5)}`;
    this.database.connection.prepare(`INSERT INTO oauth_device_requests
      (device_hash, client_id, user_hash, consent_proof, scopes_json, expires_at, interval_ms, next_poll_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 5000, ?, 'pending')`)
      .run(hash(deviceCode), clientId, hash(code), randomBytes(32).toString("base64url"), JSON.stringify(scopes), now + LIFETIME_MS, now + 5000);
    const verificationUri = `${origin}/oauth/device`;
    return {
      device_code: deviceCode, user_code: userCode, verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
      expires_in: LIFETIME_MS / 1000, interval: 5,
    };
  }

  verification(userCode: string, now = Date.now()): DeviceRequest {
    const normalized = normalizeCode(userCode);
    if (!/^[BCDFGHJKLMNPQRSTVWXYZ23456789]{10}$/.test(normalized)) throw new DeviceGrantError("invalid_request");
    const row = this.database.connection.prepare("SELECT * FROM oauth_device_requests WHERE user_hash = ?")
      .get(hash(normalized)) as unknown as DeviceRequest | undefined;
    if (!row || row.expires_at <= now || row.status !== "pending") throw new DeviceGrantError("invalid_request");
    return row;
  }

  decide(userCode: string, proof: string, user: AdminSessionUser | undefined, credentialsAt: number | undefined, now = Date.now()): void {
    const row = this.verification(userCode, now);
    const expected = Buffer.from(row.consent_proof);
    const actual = Buffer.from(proof);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new DeviceGrantError("invalid_request");
    const updated = this.database.connection.prepare(`UPDATE oauth_device_requests SET status = ?, user_json = ?, credentials_at = ?
      WHERE device_hash = ? AND status = 'pending'`)
      .run(user ? "approved" : "denied", user ? JSON.stringify(user) : null, credentialsAt ?? null, row.device_hash);
    if (updated.changes !== 1) throw new DeviceGrantError("invalid_request");
  }

  poll<T>(deviceCode: string, clientId: string, issue: (row: DeviceRequest) => T, now = Date.now()): T {
    // Errors returned by the protocol still commit their throttle updates;
    // issuance and consumption share one transaction, including across processes.
    const outcome = this.database.transaction(() => {
      const row = this.database.connection.prepare("SELECT * FROM oauth_device_requests WHERE device_hash = ?")
        .get(hash(deviceCode)) as unknown as DeviceRequest | undefined;
      if (!row || row.client_id !== clientId || row.status === "consumed") return { error: "invalid_grant" };
      if (row.expires_at <= now) return { error: "expired_token" };
      if (row.status === "denied") return { error: "access_denied" };
      if (now < row.next_poll_at) {
        this.database.connection.prepare("UPDATE oauth_device_requests SET interval_ms = interval_ms + 5000, next_poll_at = ? WHERE device_hash = ?")
          .run(now + row.interval_ms + 5000, row.device_hash);
        return { error: "slow_down" };
      }
      this.database.connection.prepare("UPDATE oauth_device_requests SET next_poll_at = ? WHERE device_hash = ?")
        .run(now + row.interval_ms, row.device_hash);
      if (row.status === "pending") return { error: "authorization_pending" };
      const value = issue(row);
      this.database.connection.prepare("UPDATE oauth_device_requests SET status = 'consumed', user_json = NULL, credentials_at = NULL WHERE device_hash = ?")
        .run(row.device_hash);
      return { value };
    });
    if (outcome.error) throw new DeviceGrantError(outcome.error);
    return outcome.value as T;
  }
}
