import { createHash } from "node:crypto";
import type { MissionGoDatabase } from "./storage/database.js";
import { conflict, invalidInput, notFound } from "./errors.js";

/** Durable references, scoped to account + conversation + operation. Never text deduplication. */
export class SessionSendRequests {
  constructor(private readonly database: MissionGoDatabase) {}

  private key(accountId: string, sessionId: string, operation: string, requestKey: string): string {
    if (!/^[a-zA-Z0-9-]{16,120}$/.test(requestKey)) throw invalidInput("Invalid send request key.");
    return `session-send:${JSON.stringify([accountId, sessionId, operation, requestKey])}`;
  }

  get(accountId: string, sessionId: string, operation: string, requestKey: string): { id: string; digest: string } | undefined {
    const row = this.database.connection.prepare("SELECT result_json FROM idempotency_keys WHERE key=? AND operation=?")
      .get(this.key(accountId, sessionId, operation, requestKey), "session_send") as { result_json: string } | undefined;
    return row ? JSON.parse(row.result_json) : undefined;
  }

  run<T extends { id: string }>(accountId: string, sessionId: string, operation: string, requestKey: string | undefined,
    payload: unknown, load: (id: string) => T | undefined, create: () => T): T {
    if (requestKey === undefined) return create();
    const key = this.key(accountId, sessionId, operation, requestKey);
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return this.database.transaction(() => {
      const previous = this.get(accountId, sessionId, operation, requestKey);
      if (previous) {
        if (previous.digest !== digest) throw conflict("agent_send_request_changed", "This send request already has different content.");
        const result = load(previous.id);
        // A cancelled/deleted upload must never silently become a new upload under an old key.
        if (!result) throw notFound("Original send result");
        return result;
      }
      const result = create();
      this.database.connection.prepare("INSERT INTO idempotency_keys(key,operation,result_json,created_at) VALUES (?,?,?,?)")
        .run(key, "session_send", JSON.stringify({ id: result.id, digest }), new Date().toISOString());
      return result;
    });
  }
}
