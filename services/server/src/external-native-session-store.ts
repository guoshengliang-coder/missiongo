import { createHash, randomUUID } from "node:crypto";

import { nodeConnectionState } from "@missiongo/domain";

import type { AgentSessionCommand, AgentSessionMessageInput, AgentSessionStatus, AgentSessionTurnState } from "./agent-session-store.js";
import { conflict, invalidInput, notFound } from "./errors.js";
import type { MissionGoStore } from "./store.js";

export interface ExternalNativeConnection {
  readonly state: "pending" | "connected" | "unavailable" | "disconnected";
  readonly nodeId?: string;
  readonly nodeName?: string;
  readonly lastSyncedAt?: string;
}
interface Row {
  id: string; account_id: string; agent_kind: string; session_ref: string; ref_kind: string;
  native_node_id: string | null; native_generation: number; native_synced_at: string | null;
  native_snapshot_json: string | null; archived_at: string | null;
  dismissed_revision: string | null;
}
interface NativeSnapshot {
  status: AgentSessionStatus; turnState: AgentSessionTurnState; error?: string; sourceArchived?: boolean;
}
interface CommandRow {
  id: string; text: string; status: AgentSessionCommand["status"]; created_at: string;
  delivering_at: string | null; delivered_at: string | null; cancelled_at: string | null; error: string | null; worker_id: string | null;
}

/** An explicit binding to one account-owned node and one exact native ID. No discovery or dispatch. */
export class ExternalNativeSessionStore {
  constructor(private readonly store: MissionGoStore) {}
  private get db() { return this.store.database.connection; }
  private row(accountId: string, id: string): Row {
    const row = this.db.prepare("SELECT * FROM external_agent_sessions WHERE id=? AND account_id=?").get(id, accountId) as Row | undefined;
    if (!row) throw notFound("Agent session");
    return row;
  }
  private items(id: string) {
    return this.db.prepare(`SELECT w.item_key, w.product_id, w.status FROM external_agent_session_items i
      JOIN work_items w ON w.id=i.item_id WHERE i.session_id=?`).all(id) as { item_key: string; product_id: string; status: string }[];
  }
  private expireCommands(id: string, workerId?: string) {
    this.db.prepare(`UPDATE external_native_commands SET status='delivery_unknown', error='Delivery could not be confirmed. Check the original client before resolving.'
      WHERE session_id=? AND status='delivering' AND (delivering_at < ? OR (? IS NOT NULL AND worker_id <> ?))`)
      .run(id, new Date(Date.now() - 5 * 60_000).toISOString(), workerId ?? null, workerId ?? null);
  }
  private command(id: string): AgentSessionCommand | undefined {
    this.expireCommands(id);
    const row = this.db.prepare("SELECT * FROM external_native_commands WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(id) as CommandRow | undefined;
    return row ? { id: row.id, kind: "message", text: row.text, status: row.status, createdAt: row.created_at,
      ...(row.error ? { error: row.error } : {}), ...(row.delivering_at ? { deliveringAt: row.delivering_at } : {}),
      ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}), ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}) } : undefined;
  }
  private requireNoPending(id: string) {
    this.expireCommands(id);
    if (this.db.prepare("SELECT 1 FROM external_native_commands WHERE session_id=? AND status IN ('queued','delivering','delivery_unknown')").get(id)) {
      throw conflict("agent_reply_pending", "Cancel or confirm the pending reply before disconnecting or archiving.");
    }
  }
  connect(accountId: string, id: string, nodeId: string): void {
    this.store.database.transaction(() => {
      const row = this.row(accountId, id);
      if (row.ref_kind !== "native" || !["codex", "opencode", "claude_code"].includes(row.agent_kind)) {
        throw conflict("external_native_unsupported", "Only a verified Codex, OpenCode or Claude bridge native ID can connect to a node.");
      }
      if (row.archived_at) throw conflict("agent_session_archived", "Restore this session before connecting.");
      const node = this.db.prepare("SELECT agents_json FROM nodes WHERE id=? AND account_id=? AND revoked_at IS NULL").get(nodeId, accountId) as { agents_json: string } | undefined;
      if (!node) throw notFound("Node");
      if (!(JSON.parse(node.agents_json) as { kind: string }[]).some((agent) => agent.kind === row.agent_kind)) {
        throw conflict("external_native_agent_unavailable", "Enable this agent on the selected node first.");
      }
      if (row.native_node_id === nodeId) return;
      this.requireNoPending(id);
      if (this.db.prepare("SELECT 1 FROM external_agent_sessions WHERE native_node_id=? AND agent_kind=? AND session_ref=? AND id<>?").get(nodeId, row.agent_kind, row.session_ref, id)
        || this.db.prepare("SELECT 1 FROM agent_sessions WHERE node_id=? AND agent_kind=? AND agent_session_ref=?").get(nodeId, row.agent_kind, row.session_ref)) {
        throw conflict("external_native_already_bound", "This native conversation is already connected to another console record.");
      }
      this.db.prepare("UPDATE external_agent_sessions SET native_node_id=?, native_generation=native_generation+1, native_snapshot_json=NULL, native_synced_at=NULL WHERE id=?").run(nodeId, id);
    });
  }
  disconnect(accountId: string, id: string): void {
    this.store.database.transaction(() => {
      this.row(accountId, id);
      this.requireNoPending(id);
      this.db.prepare("UPDATE external_agent_sessions SET native_node_id=NULL, native_generation=native_generation+1 WHERE id=?").run(id);
    });
  }
  beforeArchive(accountId: string, id: string): void { this.row(accountId, id); this.requireNoPending(id); }

  overlay(accountId: string, id: string, includeMessages = true) {
    const row = this.row(accountId, id);
    const snapshot = row.native_snapshot_json ? JSON.parse(row.native_snapshot_json) as NativeSnapshot : undefined;
    const node = row.native_node_id ? this.db.prepare("SELECT COALESCE(nickname,name) AS name,last_seen_at,revoked_at FROM nodes WHERE id=? AND account_id=?")
      .get(row.native_node_id, accountId) as { name: string; last_seen_at: string | null; revoked_at: string | null } | undefined : undefined;
    const online = node && !node.revoked_at && nodeConnectionState(node.last_seen_at ?? undefined) === "online";
    const connected = Boolean(row.native_node_id && online && snapshot && !["failed", "unavailable", "suspended"].includes(snapshot.status) && !snapshot.sourceArchived);
    const nativeConnection: ExternalNativeConnection | undefined = row.native_generation === 0 ? undefined : {
      state: !row.native_node_id ? "disconnected" : !snapshot ? "pending" : connected ? "connected" : "unavailable",
      ...(row.native_node_id ? { nodeId: row.native_node_id } : {}), ...(node ? { nodeName: node.name } : {}),
      ...(row.native_synced_at ? { lastSyncedAt: row.native_synced_at } : {}),
    };
    const nativeMessages = (this.db.prepare(includeMessages
      ? "SELECT id,payload_json FROM external_native_messages WHERE session_id=? ORDER BY position,rowid"
      : "SELECT id,payload_json FROM external_native_messages WHERE session_id=? ORDER BY position DESC,rowid DESC LIMIT 1").all(id) as { id: string; payload_json: string }[])
      .map((message) => ({ ...JSON.parse(message.payload_json) as AgentSessionMessageInput, id: message.id }));
    const command = this.command(id);
    const revision = snapshot && row.native_node_id ? createHash("sha256").update(JSON.stringify([nativeMessages.at(-1), snapshot.status, snapshot.turnState.waitingForInput, snapshot.error])).digest("hex") : undefined;
    const needed = Boolean(revision && (snapshot?.turnState.waitingForInput || snapshot?.status === "failed" || snapshot?.error) && row.dismissed_revision !== revision);
    return { ...(nativeConnection ? { nativeConnection } : {}), nativeMessages,
      ...(snapshot ? { status: !row.native_node_id || !online ? "unavailable" as const : snapshot.status, turnState: snapshot.turnState,
        ...(row.native_synced_at ? { updatedAt: row.native_synced_at } : {}),
        ...(snapshot.error ? { lastError: snapshot.error } : {}) } : {}),
      ...(command ? { command } : {}), replyable: connected && !row.archived_at && this.items(id).some((item) => item.status !== "done"),
      ...(revision ? { attention: { state: needed ? "needed" as const : "not_needed" as const, revision,
        ...(needed ? { kind: "action" as const, reason: snapshot?.error ?? nativeMessages.at(-1)?.text ?? "请查看原生会话。" } : {}),
        ...(row.dismissed_revision === revision ? { dismissed: true } : {}) }, needsAttention: needed, waitingForReply: needed } : {}),
    };
  }
  enqueue(accountId: string, id: string, textValue: string): AgentSessionCommand {
    const text = textValue.trim();
    if (!text || text.length > 20_000) throw invalidInput("Reply text must contain 1 to 20000 characters.");
    return this.store.database.transaction(() => {
      if (!this.overlay(accountId, id, false).replyable) throw conflict("external_native_not_ready", "Connect the native conversation and wait for a successful node sync before replying.");
      this.requireNoPending(id);
      const commandId = randomUUID(); const now = new Date().toISOString();
      this.db.prepare("INSERT INTO external_native_commands(id,session_id,text,status,created_at) VALUES (?,?,?,'queued',?)").run(commandId, id, text, now);
      this.db.prepare("UPDATE external_agent_sessions SET activity_at=? WHERE id=?").run(now, id);
      return this.command(id)!;
    });
  }
  cancel(accountId: string, id: string, commandId: string): AgentSessionCommand {
    this.row(accountId, id);
    const changed = this.db.prepare("UPDATE external_native_commands SET status='cancelled',cancelled_at=? WHERE session_id=? AND id=? AND status='queued'").run(new Date().toISOString(), id, commandId);
    if (!changed.changes) throw conflict("agent_reply_not_cancellable", "Only a queued reply can be cancelled.");
    return this.command(id)!;
  }
  resolve(accountId: string, id: string, commandId: string, outcome: "received" | "not_received"): AgentSessionCommand {
    this.row(accountId, id); this.expireCommands(id);
    const changed = this.db.prepare("UPDATE external_native_commands SET status=?,delivered_at=?,error=? WHERE session_id=? AND id=? AND status='delivery_unknown'")
      .run(outcome === "received" ? "delivered" : "failed", outcome === "received" ? new Date().toISOString() : null,
        outcome === "not_received" ? "User confirmed the reply was not received; it was not resent." : null, id, commandId);
    if (!changed.changes) throw conflict("agent_reply_not_uncertain", "This reply no longer needs delivery confirmation.");
    return this.command(id)!;
  }
  listForNode(accountId: string, nodeId: string, workerId: string, authorizeProduct: (id: string, execute: boolean) => void) {
    const rows = this.db.prepare("SELECT * FROM external_agent_sessions WHERE account_id=? AND native_node_id=? AND archived_at IS NULL ORDER BY id LIMIT 100").all(accountId, nodeId) as unknown as Row[];
    return rows.flatMap((row) => {
      try { this.items(row.id).forEach((item) => authorizeProduct(item.product_id, false)); } catch { return []; }
      this.expireCommands(row.id, workerId);
      let command = this.command(row.id);
      if (command && !["queued", "delivering"].includes(command.status)) command = undefined;
      if (command) {
        try { this.items(row.id).forEach((item) => authorizeProduct(item.product_id, true)); }
        catch { command = undefined; }
      }
      if (this.items(row.id).every((item) => item.status === "done")) command = undefined;
      const snapshot = row.native_snapshot_json ? JSON.parse(row.native_snapshot_json) as NativeSnapshot : undefined;
      return [{ id: row.id, agentKind: row.agent_kind, sessionRef: row.session_ref, status: snapshot?.status ?? "unavailable",
        lifecycle: "keep", occupiesExecutionSlot: false, externalBindingGeneration: row.native_generation,
        ...(command ? { command } : {}) }];
    });
  }
  recordSnapshot(input: { accountId: string; nodeId: string; sessionId: string; generation: number; workerId: string;
    status: AgentSessionStatus; messages: readonly AgentSessionMessageInput[]; turnState: AgentSessionTurnState;
    error?: string; sourceArchived?: boolean; commandId?: string; commandStatus?: "delivering" | "delivery_unknown" | "delivered" | "failed"; commandError?: string },
  authorizeProduct: (id: string, execute: boolean) => void): void {
    this.store.database.transaction(() => {
      const row = this.row(input.accountId, input.sessionId);
      if (row.native_node_id !== input.nodeId || row.native_generation !== input.generation || row.archived_at) throw notFound("Native binding");
      this.items(row.id).forEach((item) => authorizeProduct(item.product_id, Boolean(input.commandId)));
      if (Boolean(input.commandId) !== Boolean(input.commandStatus)) throw invalidInput("A command ID and status must be reported together.");
      if (input.commandStatus === "delivering" && this.items(row.id).every((item) => item.status === "done")) throw conflict("agent_session_work_finished", "The linked work is done.");
      if (input.messages.length > 2000) throw invalidInput("Too many native messages.");
      const now = new Date().toISOString(); let changed = false;
      let position = (this.db.prepare("SELECT COALESCE(MAX(position),-1) AS position FROM external_native_messages WHERE session_id=?").get(row.id) as { position: number }).position;
      for (const message of input.messages) {
        if (!message.sourceId || message.sourceId.length > 200 || message.text.length > 100_000) throw invalidInput("Invalid native message.");
        const old = this.db.prepare("SELECT payload_json FROM external_native_messages WHERE session_id=? AND source_id=?").get(row.id, message.sourceId) as { payload_json: string } | undefined;
        const previous = old ? JSON.parse(old.payload_json) as AgentSessionMessageInput : undefined;
        const questions = message.questions?.map((question, index) => {
          const prior = previous?.questions?.[index];
          return { ...question, ...(prior?.answered !== undefined ? { answered: prior.answered } : {}), ...(prior?.withdrawn ? { withdrawn: true } : {}) };
        }) ?? previous?.questions?.map((question) => ({ ...question, ...(question.answered === undefined ? { withdrawn: true } : {}) }));
        const payload = JSON.stringify({ ...message, ...(questions ? { questions } : {}), occurredAt: message.occurredAt ?? previous?.occurredAt ?? now });
        if (payload !== old?.payload_json) {
          changed = true;
          this.db.prepare(`INSERT INTO external_native_messages(id,session_id,source_id,payload_json,position) VALUES (?,?,?,?,?)
            ON CONFLICT(session_id,source_id) DO UPDATE SET payload_json=excluded.payload_json`).run(randomUUID(), row.id, message.sourceId, payload, ++position);
        }
      }
      // A healthy source read settles cards that disappeared; transport failure
      // and truncated ordinary history must never erase the transcript itself.
      if (!["unavailable", "failed"].includes(input.status) && !input.error) {
        const present = new Set(input.messages.map((message) => message.sourceId));
        const cards = this.db.prepare("SELECT source_id,payload_json FROM external_native_messages WHERE session_id=? AND json_type(payload_json,'$.questions')='array'").all(row.id) as { source_id: string; payload_json: string }[];
        for (const card of cards) {
          if (present.has(card.source_id)) continue;
          const message = JSON.parse(card.payload_json) as AgentSessionMessageInput;
          const questions = message.questions!.map((question) => ({ ...question, ...(question.answered === undefined ? { withdrawn: true } : {}) }));
          const payload = JSON.stringify({ ...message, questions });
          if (payload !== card.payload_json) {
            changed = true;
            this.db.prepare("UPDATE external_native_messages SET payload_json=? WHERE session_id=? AND source_id=?").run(payload, row.id, card.source_id);
          }
        }
      }
      const snapshot = JSON.stringify({ status: input.status, turnState: input.turnState, ...(input.error ? { error: input.error } : {}), ...(input.sourceArchived ? { sourceArchived: true } : {}) });
      const clocks = this.db.prepare("SELECT activity_at,unread_at FROM external_agent_sessions WHERE id=?").get(row.id) as { activity_at: string; unread_at: string | null };
      const clock = new Date(Math.max(Date.now(), Date.parse(clocks.activity_at) + 1, clocks.unread_at ? Date.parse(clocks.unread_at) + 1 : 0)).toISOString();
      this.db.prepare(`UPDATE external_agent_sessions SET native_snapshot_json=?,native_synced_at=?,
        activity_at=CASE WHEN ? THEN ? ELSE activity_at END, unread_at=CASE WHEN ? THEN ? ELSE unread_at END WHERE id=?`)
        .run(snapshot, now, changed ? 1 : 0, clock, changed ? 1 : 0, clock, row.id);
      if (input.commandId && input.commandStatus) {
        const command = this.db.prepare("SELECT * FROM external_native_commands WHERE id=? AND session_id=?").get(input.commandId, row.id) as CommandRow | undefined;
        if (!command) throw notFound("Native reply");
        if (input.commandStatus === "delivering") {
          if (command.status !== "queued" && !(command.status === "delivering" && command.worker_id === input.workerId)) throw conflict("agent_reply_changed", "The reply can no longer be reserved.");
          this.db.prepare("UPDATE external_native_commands SET status='delivering',delivering_at=COALESCE(delivering_at,?),worker_id=? WHERE id=?").run(now, input.workerId, command.id);
        } else if (command.status === "delivering" || command.status === "delivery_unknown") {
          if (command.worker_id !== input.workerId) throw conflict("agent_reply_worker_changed", "The reply belongs to a previous worker; confirm delivery manually.");
          this.db.prepare("UPDATE external_native_commands SET status=?,error=?,delivered_at=? WHERE id=?").run(input.commandStatus, input.commandError ?? null, input.commandStatus === "delivered" ? now : null, command.id);
        } else if (command.status !== input.commandStatus) throw conflict("agent_reply_changed", "The reply can no longer change state.");
      }
    });
  }
}
