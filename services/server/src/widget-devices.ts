import { invalidInput } from "./errors.js";
import type { MissionGoDatabase } from "./storage/database.js";

const MAX_FCM_TOKEN_LENGTH = 4_096;

/**
 * AND-150: the FCM tokens the server-driven widget refresh pushes to. The row's
 * lifetime is the token's: FCM mints a new token per install, so a re-register
 * upserts, and Google reporting a token gone (404/410) deletes it.
 */
export class WidgetDeviceStore {
  constructor(private readonly database: MissionGoDatabase) {}

  register(accountId: string, tokenValue: string): void {
    const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
    if (!token) throw invalidInput("token is required.");
    if (token.length > MAX_FCM_TOKEN_LENGTH) throw invalidInput("token is too long.");
    const now = new Date().toISOString();
    this.database.connection
      .prepare(
        `INSERT INTO widget_devices (fcm_token, account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(fcm_token) DO UPDATE SET
           account_id = excluded.account_id,
           updated_at = excluded.updated_at`,
      )
      .run(token, accountId, now, now);
  }

  unregister(accountId: string, tokenValue: string): boolean {
    const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
    if (!token) throw invalidInput("token is required.");
    return this.database.connection
      .prepare("DELETE FROM widget_devices WHERE fcm_token = ? AND account_id = ?")
      .run(token, accountId).changes > 0;
  }

  listForAccount(accountId: string): readonly string[] {
    return (this.database.connection
      .prepare("SELECT fcm_token FROM widget_devices WHERE account_id = ?")
      .all(accountId) as unknown as Array<{ fcm_token: string }>)
      .map((row) => row.fcm_token);
  }

  /** Accounts worth recomputing a summary for: those with at least one device. */
  accountIds(): readonly string[] {
    return (this.database.connection
      .prepare("SELECT DISTINCT account_id FROM widget_devices")
      .all() as unknown as Array<{ account_id: string }>)
      .map((row) => row.account_id);
  }

  forget(token: string): void {
    this.database.connection.prepare("DELETE FROM widget_devices WHERE fcm_token = ?").run(token);
  }
}
