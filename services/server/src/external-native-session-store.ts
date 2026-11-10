import { SessionSendRequests } from "./session-send-requests.js";
import { observeMessageTimes, recordMessageTime } from "./session-message-clock.js";
import { observeSessionUnread } from "./session-unread.js";
import { isConversationMessage } from "@missiongo/domain";
import { ImplementationPlans } from "./implementation-plans.js";
import { AgentSessionAttachments, type AgentSessionAttachment } from "./agent-session-attachments.js";
import { assertExternalExecution } from "./builder-authority.js";
import { createHash, randomUUID } from "node:crypto";

import { nodeConnectionState } from "@missiongo/domain";

import { sessionHealth } from "./agent-session-health.js";

import type { AgentSessionActivity, AgentSessionCommand, AgentSessionMessageInput, AgentSessionStatus, AgentSessionTurnState } from "./agent-session-store.js";
import { parseAgentModels, requireAvailableMode, requireOfferedModel, type AgentRunSettings } from "./agent-settings.js";
import type { AgentSessionSettings } from "./agent-session-store.js";
import type { AgentKind, AgentModeCapability } from "@missiongo/domain";
import { conflict, invalidInput, notFound } from "./errors.js";
import type { MissionGoStore } from "./store.js";
import { autoArchiveFinishedConversations } from "./auto-archive.js";

export interface ExternalNativeConnection {
  readonly state: "pending" | "connected" | "unavailable" | "disconnected";
  readonly nodeId?: string;
  readonly nodeName?: string;
  readonly lastSyncedAt?: string;
  readonly waitingSince?: string;
  readonly automatic?: boolean;
}
interface Row {
  id: string; account_id: string; product_id: string | null; agent_kind: string; session_ref: string; ref_kind: string;
  native_node_id: string | null; native_generation: number; native_synced_at: string | null;
  native_snapshot_json: string | null; archived_at: string | null;
  dismissed_revision: string | null;
  native_auto_connect: number;
  native_settings_json: string | null;
  created_at: string;
}
interface NodeRow { name:string;last_seen_at:string|null;revoked_at:string|null }
interface OverlayContext {
  row:Row;node?:NodeRow;nativeMessages:Array<AgentSessionMessageInput & {id:string}>;
  command?:AgentSessionCommand | undefined;workOpen:boolean;
}
type SettingsField = "mode" | "model" | "effort";
interface SettingsState {
  revision: number; settled: number; desired?: AgentRunSettings;
  values?: AgentRunSettings; error?: string;
}
interface NativeSnapshot {
  settingsSupport?: readonly SettingsField[]; model?: string; effort?: string; mode?: string;
  status: AgentSessionStatus; turnState: AgentSessionTurnState; activities?: readonly AgentSessionActivity[]; error?: string; sourceArchived?: boolean; supportsAttachments?: boolean;
}
interface CommandRow {
  id: string; text: string; status: AgentSessionCommand["status"]; created_at: string;
  delivering_at: string | null; delivered_at: string | null; cancelled_at: string | null; error: string | null; worker_id: string | null;
}

/** An explicit binding to one account-owned node and one exact native ID. No discovery or dispatch. */
export class ExternalNativeSessionStore {
  private readonly attachments: AgentSessionAttachments;
  constructor(private readonly store: MissionGoStore, attachments?: AgentSessionAttachments) {
    this.attachments = attachments ?? new AgentSessionAttachments(store.database, "./data/attachments", true);
  }
  supportsAttachments(accountId: string, id: string): boolean {
    const row = this.row(accountId, id);
    return Boolean(row.native_snapshot_json && (JSON.parse(row.native_snapshot_json) as NativeSnapshot).supportsAttachments);
  }
  authorizeAttachment(accountId: string, nodeId: string, id: string, commandId: string, workerId: string,
    authorizeProduct: (id: string, execute: boolean) => void): void {
    assertExternalExecution(this.store.database, id);
    const row = this.row(accountId, id);
    const command = this.command(id);
    const reserved = this.db.prepare("SELECT worker_id FROM external_native_commands WHERE id=? AND session_id=?").get(commandId, id) as { worker_id: string } | undefined;
    if (row.archived_at || row.native_node_id !== nodeId || command?.id !== commandId || command.status !== "delivering"
      || reserved?.worker_id !== workerId) throw notFound("Agent session attachment");
    this.authorizeProducts(id,authorizeProduct,true);
  }
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
  private authorizeProducts(id: string, authorize: (id:string, execute:boolean)=>void, execute:boolean) {
    const project=this.db.prepare("SELECT product_id FROM external_agent_sessions WHERE id=?").get(id) as {product_id:string|null}|undefined;
    for (const productId of new Set([...(project?.product_id ? [project.product_id] : []),...this.items(id).map(item=>item.product_id)])) authorize(productId,execute);
  }
  private workOpen(id: string) {
    return Boolean((this.db.prepare("SELECT product_id FROM external_agent_sessions WHERE id=?").get(id) as {product_id:string|null}|undefined)?.product_id)
      || this.items(id).some(item=>item.status!=="done");
  }
  private expireCommands(id: string, workerId?: string) {
    this.db.prepare(`UPDATE external_native_commands SET status='delivery_unknown', error='Delivery could not be confirmed. Check the original client before resolving.'
      WHERE session_id=? AND status='delivering' AND (delivering_at < ? OR (? IS NOT NULL AND worker_id <> ?))`)
      .run(id, new Date(Date.now() - 5 * 60_000).toISOString(), workerId ?? null, workerId ?? null);
  }
  private command(id: string, commandId?: string): AgentSessionCommand | undefined {
    this.expireCommands(id);
    const row = (commandId
      ? this.db.prepare("SELECT * FROM external_native_commands WHERE session_id=? AND id=?").get(id, commandId)
      : this.db.prepare("SELECT * FROM external_native_commands WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(id)) as CommandRow | undefined;
    const attachments = row ? this.attachments.listForCommand(row.id) : [];
    return row ? { id: row.id, kind: "message", text: row.text,
      ...(new ImplementationPlans(this.store.database).commandRevision(row.id) ? { planApprovalRevision: new ImplementationPlans(this.store.database).commandRevision(row.id) } : {}), status: row.status, createdAt: row.created_at,
      ...(attachments.length ? { attachments } : {}),
      ...(row.error ? { error: row.error } : {}), ...(row.delivering_at ? { deliveringAt: row.delivering_at } : {}),
      ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}), ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}) } : undefined;
  }
  private requireNoPending(id: string) {
    this.expireCommands(id);
    if (this.db.prepare("SELECT 1 FROM external_native_commands WHERE session_id=? AND status IN ('queued','delivering','delivery_unknown')").get(id)) {
      throw conflict("agent_reply_pending", "Cancel or confirm the pending reply before disconnecting or archiving.");
    }
  }
  private alreadyBound(row: Row, nodeId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM external_agent_sessions WHERE native_node_id=? AND agent_kind=? AND session_ref=? AND id<>?")
      .get(nodeId, row.agent_kind, row.session_ref, row.id)
      || this.db.prepare("SELECT 1 FROM agent_sessions WHERE node_id=? AND agent_kind=? AND agent_session_ref=?")
        .get(nodeId, row.agent_kind, row.session_ref));
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
      if (this.alreadyBound(row, nodeId)) {
        throw conflict("external_native_already_bound", "This native conversation is already connected to another console record.");
      }
      this.db.prepare("UPDATE external_agent_sessions SET native_node_id=?, native_generation=native_generation+1, native_snapshot_json=NULL, native_synced_at=NULL, native_settings_json=NULL WHERE id=?").run(nodeId, id);
    });
  }
  disconnect(accountId: string, id: string): void {
    this.store.database.transaction(() => {
      this.row(accountId, id);
      this.requireNoPending(id);
      this.db.prepare("UPDATE implementation_plan_continuations SET state='cancelled' WHERE account_id=? AND session_id=? AND state='waiting'").run(accountId,id);
      this.db.prepare("UPDATE external_agent_sessions SET native_node_id=NULL, native_auto_connect=0, native_generation=native_generation+1, native_settings_json=NULL WHERE id=?").run(id);
    });
  }
  beforeArchive(accountId: string, id: string): void { this.row(accountId, id); this.requireNoPending(id); }

  /** Request-local list projection; never retain this across permission changes. */
  overlays(accountId:string,ids:readonly string[]) {
    const result=new Map<string,ReturnType<ExternalNativeSessionStore["overlay"]>>();
    if (!ids.length) return result;
    const selected=JSON.stringify(ids);
    const rows=this.db.prepare(`SELECT s.*,s.product_id IS NOT NULL OR EXISTS(SELECT 1 FROM external_agent_session_items i
      JOIN work_items w ON w.id=i.item_id WHERE i.session_id=s.id AND w.status<>'done') AS work_open
      FROM external_agent_sessions s WHERE s.account_id=? AND s.id IN (SELECT value FROM json_each(?))`)
      .all(accountId,selected) as unknown as Array<Row & {work_open:number}>;
    const nodes=this.db.prepare(`SELECT id,COALESCE(nickname,name) AS name,last_seen_at,revoked_at FROM nodes WHERE account_id=?
      AND id IN (SELECT native_node_id FROM external_agent_sessions WHERE account_id=? AND id IN (SELECT value FROM json_each(?)))`)
      .all(accountId,accountId,selected) as unknown as Array<NodeRow & {id:string}>;
    const nodeMap=new Map(nodes.map(node=>[node.id,node]));
    const messages=this.db.prepare(`SELECT session_id,id,payload_json FROM external_native_messages WHERE rowid IN (
      SELECT (SELECT m.rowid FROM external_native_messages m WHERE m.session_id=s.id
        AND COALESCE(json_extract(m.payload_json,'$.phase'),'')<>'execution' ORDER BY m.position DESC,m.rowid DESC LIMIT 1)
      FROM external_agent_sessions s WHERE s.account_id=? AND s.id IN (SELECT value FROM json_each(?)))`)
      .all(accountId,selected) as {session_id:string;id:string;payload_json:string}[];
    const messageMap=new Map(messages.map(row=>[row.session_id,[{...JSON.parse(row.payload_json),id:row.id}]]));
    this.db.prepare(`UPDATE external_native_commands SET status='delivery_unknown',error='Delivery could not be confirmed. Check the original client before resolving.'
      WHERE status='delivering' AND delivering_at<? AND session_id IN
        (SELECT id FROM external_agent_sessions WHERE account_id=? AND id IN (SELECT value FROM json_each(?)))`)
      .run(new Date(Date.now()-5*60_000).toISOString(),accountId,selected);
    const commandIds=new Set((this.db.prepare(`SELECT DISTINCT session_id FROM external_native_commands
      WHERE session_id IN (SELECT id FROM external_agent_sessions WHERE account_id=? AND id IN (SELECT value FROM json_each(?)))`)
      .all(accountId,selected) as {session_id:string}[]).map(row=>row.session_id));
    for (const row of rows) result.set(row.id,this.overlay(accountId,row.id,false,{row,
      ...(row.native_node_id && nodeMap.has(row.native_node_id) ? {node:nodeMap.get(row.native_node_id)!} : {}),
      nativeMessages:messageMap.get(row.id)??[],...(commandIds.has(row.id)?{command:this.command(row.id)}:{}),workOpen:Boolean(row.work_open)}));
    return result;
  }

  overlay(accountId: string, id: string, includeMessages = true, context?:OverlayContext, includeAttachments = includeMessages) {
    const row = context?.row ?? this.row(accountId, id);
    const snapshot = row.native_snapshot_json ? JSON.parse(row.native_snapshot_json) as NativeSnapshot : undefined;
    const node = context ? context.node : row.native_node_id ? this.db.prepare("SELECT COALESCE(nickname,name) AS name,last_seen_at,revoked_at FROM nodes WHERE id=? AND account_id=?")
      .get(row.native_node_id, accountId) as { name: string; last_seen_at: string | null; revoked_at: string | null } | undefined : undefined;
    const online = node && !node.revoked_at && nodeConnectionState(node.last_seen_at ?? undefined) === "online";
    const health = snapshot ? sessionHealth(snapshot.status, row.native_node_id && !row.archived_at && !snapshot.sourceArchived ? snapshot.turnState : {}) : undefined;
    const connected = Boolean(row.native_node_id && online && snapshot && !["failed", "unavailable", "suspended"].includes(health!.status) && !snapshot.sourceArchived);
    const nativeConnection: ExternalNativeConnection | undefined = row.native_generation === 0 && !row.native_auto_connect ? undefined : {
      state: !row.native_node_id ? row.native_auto_connect ? "pending" : "disconnected" : !snapshot ? "pending" : connected ? "connected" : "unavailable",
      ...(row.native_auto_connect ? { automatic: true } : {}),
      ...(!row.native_node_id && row.native_auto_connect ? { waitingSince: row.created_at } : {}),
      ...(row.native_node_id ? { nodeId: row.native_node_id } : {}), ...(node ? { nodeName: node.name } : {}),
      ...(row.native_synced_at ? { lastSyncedAt: row.native_synced_at } : {}),
    };
    const nativeMessages = context?.nativeMessages ?? (this.db.prepare(includeMessages
      ? "SELECT id,payload_json FROM external_native_messages WHERE session_id=? AND COALESCE(json_extract(payload_json,'$.phase'),'') <> 'execution' ORDER BY position,rowid"
      : "SELECT id,payload_json FROM external_native_messages WHERE session_id=? AND COALESCE(json_extract(payload_json,'$.phase'),'') <> 'execution' ORDER BY position DESC,rowid DESC LIMIT 1").all(id) as { id: string; payload_json: string }[])
      .map((message) => ({ ...JSON.parse(message.payload_json) as AgentSessionMessageInput, id: message.id }));
    const command = context ? context.command : this.command(id);
    const revision = snapshot && row.native_node_id ? createHash("sha256").update(JSON.stringify([nativeMessages.at(-1), snapshot.status, snapshot.turnState.waitingForInput, snapshot.error])).digest("hex") : undefined;
    const needed = Boolean(revision && (snapshot?.turnState.waitingForInput || snapshot?.status === "failed" || snapshot?.error || health?.reason) && (health?.reason || row.dismissed_revision !== revision));
    const filesByCommand = new Map<string, AgentSessionAttachment[]>();
    if (includeAttachments) for (const { commandId, ...file } of this.attachments.listForSession(id)) {
      const files = filesByCommand.get(commandId) ?? [];
      files.push(file); filesByCommand.set(commandId, files);
    }
    const attachmentMessages = filesByCommand.size ? (this.db.prepare("SELECT id,text,status,created_at FROM external_native_commands WHERE session_id=? ORDER BY created_at,rowid").all(id) as unknown as CommandRow[])
      .flatMap((entry) => {
        const attachments = filesByCommand.get(entry.id);
        return attachments ? [{ commandId: entry.id, text: entry.text, status: entry.status, createdAt: entry.created_at, attachments }] : [];
      }) : [];
    return { ...(nativeConnection ? { nativeConnection } : {}), nativeMessages, attachmentMessages,
      settings: this.settings(row, snapshot, connected, context?.workOpen),
      ...(snapshot ? { status: !row.native_node_id || !online ? "unavailable" as const : health!.status, turnState: snapshot.turnState, activities: snapshot.activities ?? [],
        ...(row.native_synced_at ? { updatedAt: row.native_synced_at } : {}),
        ...(health?.reason || snapshot.error ? { lastError: health?.reason ?? snapshot.error } : {}) } : {}),
      ...(command ? { command } : {}), replyable: connected && !row.archived_at && (context ? context.workOpen : this.workOpen(id)),
      ...(revision ? { attention: { state: needed ? "needed" as const : "not_needed" as const, ...(!health?.reason ? { revision } : {}),
        ...(needed ? { kind: "action" as const, reason: health?.reason ?? snapshot?.error ?? nativeMessages.at(-1)?.text ?? "请查看原生会话。" } : {}),
        ...(row.dismissed_revision === revision && !health?.reason ? { dismissed: true } : {}) }, needsAttention: needed, waitingForReply: needed } : {}),
    };
  }
  private settings(row: Row, snapshot: NativeSnapshot | undefined, connected: boolean, workOpen?:boolean): AgentSessionSettings {
    const state = this.settingsState(row);
    const fields = snapshot?.settingsSupport ?? [];
    const values = { ...state.values, ...(snapshot?.mode ? { mode: snapshot.mode } : {}),
      ...(snapshot?.model ? { model: snapshot.model } : {}), ...(snapshot?.effort ? { effort: snapshot.effort } : {}) };
    return { ...values, mode: values.mode ?? "external", supportedFields: fields,
      adjustable: connected && !row.archived_at && fields.length > 0 && (workOpen ?? this.workOpen(row.id)),
      applyOn: row.agent_kind === "codex" ? "next_reply" : "idle",
      ...(!connected ? { unavailableReason: "connect" as const } : snapshot?.settingsSupport === undefined
        ? { unavailableReason: "upgrade" as const } : fields.length === 0 ? { unavailableReason: "source" as const } : {}),
      ...(state.revision > state.settled && state.desired?.model ? { requestedModel: state.desired.model } : {}),
      ...(state.revision > state.settled ? { pending: { ...state.desired, revision: state.revision } } : {}),
      ...(state.error ? { error: state.error } : {}) };
  }
  private settingsState(row: Row): SettingsState {
    return row.native_settings_json ? JSON.parse(row.native_settings_json) as SettingsState : { revision: 0, settled: 0 };
  }
  requestSettings(accountId: string, id: string, change: AgentRunSettings): AgentSessionSettings {
    return this.store.database.transaction(() => {
      assertExternalExecution(this.store.database, id);
      const row = this.row(accountId, id);
      const overlay = this.overlay(accountId, id, false);
      if (!overlay.settings.adjustable) throw conflict("external_settings_unavailable", "This source cannot adjust settings right now.");
      this.requireNoPending(id);
      const fields = Object.keys(change) as SettingsField[];
      if (!fields.length) throw invalidInput("Choose a mode, model or effort to change.");
      if (fields.some((field) => !overlay.settings.supportedFields?.includes(field))) {
        throw conflict("external_settings_unsupported", "This source does not support the selected setting.");
      }
      const node = this.db.prepare("SELECT agents_json FROM nodes WHERE id=? AND account_id=? AND revoked_at IS NULL")
        .get(row.native_node_id!, accountId) as { agents_json: string } | undefined;
      const agent = node && (JSON.parse(node.agents_json) as { kind: string; models?: unknown; modes?: readonly AgentModeCapability[] }[]).find((entry) => entry.kind === row.agent_kind);
      const state = this.settingsState(row);
      // Carry only still-pending fields. Settled settings belong to the source,
      // which may have changed them in its own client in the meantime.
      const next = { ...(state.revision > state.settled ? state.desired : {}), ...change };
      requireAvailableMode(row.agent_kind as AgentKind,next.mode ?? overlay.settings.mode,agent?.modes,next.model ?? overlay.settings.model);
      if (next.effort && !next.model && !overlay.settings.model) throw invalidInput("Choose a model before changing its effort.");
      requireOfferedModel(row.agent_kind as AgentKind, parseAgentModels(agent?.models), {
        ...next, ...(next.effort && !next.model && overlay.settings.model ? { model: overlay.settings.model } : {}) });
      this.db.prepare("UPDATE external_agent_sessions SET native_settings_json=? WHERE id=?")
        .run(JSON.stringify({ ...state, desired: next, revision: state.revision + 1, error: undefined }), id);
      return this.overlay(accountId, id, false).settings;
    });
  }
  enqueue(accountId: string, id: string, textValue: string, attachmentIds: readonly string[] = [], requestKey?: string): AgentSessionCommand {
    assertExternalExecution(this.store.database,id);
    const text = textValue.trim();
    if ((!text && !attachmentIds.length) || text.length > 20_000) throw invalidInput("Reply text or attachments are required (at most 20000 characters).");
    if (attachmentIds.length && !this.supportsAttachments(accountId, id)) throw conflict("agent_node_attachments_unsupported", "Update the MissionGo node before sending attachments.");
    return this.store.database.transaction(() => {
      if (!this.overlay(accountId, id, false).replyable) throw conflict("external_native_not_ready", "Connect the native conversation and wait for a successful node sync before replying.");
      return new SessionSendRequests(this.store.database).run(accountId, id, "command", requestKey,
        [text, attachmentIds], commandId => this.command(id, commandId), () => {
          this.requireNoPending(id);
          const commandId = randomUUID(); const now = new Date().toISOString();
          this.db.prepare("INSERT INTO external_native_commands(id,session_id,text,status,created_at) VALUES (?,?,?,'queued',?)").run(commandId, id, text, now);
          this.attachments.bind(id, accountId, commandId, attachmentIds);
          recordMessageTime(this.db, `external:${id}`, `command:${commandId}`, now);
          this.db.prepare("UPDATE external_agent_sessions SET activity_at=? WHERE id=?").run(now, id);
          return this.command(id)!;
      });
    });
  }
  commandById(id: string, commandId: string): AgentSessionCommand | undefined { return this.command(id, commandId); }
  cancel(accountId: string, id: string, commandId: string): AgentSessionCommand {
    return this.store.database.transaction(() => {
      this.row(accountId, id);
      const changed = this.db.prepare("UPDATE external_native_commands SET status='cancelled',cancelled_at=? WHERE session_id=? AND id=? AND status='queued'").run(new Date().toISOString(), id, commandId);
      if (!changed.changes) throw conflict("agent_reply_not_cancellable", "Only a queued reply can be cancelled.");
      const command = this.command(id)!;
      autoArchiveFinishedConversations(this.store.database, accountId, undefined, [id]);
      return command;
    });
  }
  resolve(accountId: string, id: string, commandId: string, outcome: "received" | "not_received"): AgentSessionCommand {
    return this.store.database.transaction(() => {
      this.row(accountId, id); this.expireCommands(id);
      const changed = this.db.prepare("UPDATE external_native_commands SET status=?,delivered_at=?,error=? WHERE session_id=? AND id=? AND status='delivery_unknown'")
        .run(outcome === "received" ? "delivered" : "failed", outcome === "received" ? new Date().toISOString() : null,
          outcome === "not_received" ? "User confirmed the reply was not received; it was not resent." : null, id, commandId);
      if (!changed.changes) throw conflict("agent_reply_not_uncertain", "This reply no longer needs delivery confirmation.");
      const command = this.command(id)!;
      autoArchiveFinishedConversations(this.store.database, accountId, undefined, [id]);
      return command;
    });
  }
  listForNode(accountId: string, nodeId: string, workerId: string, authorizeProduct: (id: string, execute: boolean) => void, allowAutomatic = false, allowSettings = false) {
    const node = this.db.prepare("SELECT agents_json FROM nodes WHERE id=? AND account_id=? AND revoked_at IS NULL").get(nodeId, accountId) as { agents_json: string } | undefined;
    if (!node) return [];
    const enabled = new Set((JSON.parse(node.agents_json) as { kind: string }[]).map((agent) => agent.kind));
    // Exclude duplicate automatic probes before LIMIT so historical mirrors
    // cannot crowd out unrelated sessions. Existing channels remain in the
    // list; a released binding becomes eligible again on the next poll.
    const rows = this.db.prepare(`SELECT s.* FROM external_agent_sessions s WHERE s.account_id=? AND s.archived_at IS NULL
      AND (s.native_node_id=? OR (? AND s.native_node_id IS NULL AND s.native_auto_connect=1 AND s.ref_kind='native'
        AND NOT EXISTS (SELECT 1 FROM external_agent_sessions bound
          WHERE bound.native_node_id=? AND bound.agent_kind=s.agent_kind AND bound.session_ref=s.session_ref AND bound.id<>s.id)
        AND NOT EXISTS (SELECT 1 FROM agent_sessions bound
          WHERE bound.node_id=? AND bound.agent_kind=s.agent_kind AND bound.agent_session_ref=s.session_ref)))
      ORDER BY s.native_node_id IS NULL, s.id LIMIT 100`).all(accountId, nodeId, allowAutomatic ? 1 : 0, nodeId, nodeId) as unknown as Row[];
    return rows.flatMap((row) => {
      const automatic = row.native_node_id === null;
      if (automatic && (!enabled.has(row.agent_kind) || !this.workOpen(row.id))) return [];
      try { this.authorizeProducts(row.id,authorizeProduct,automatic); } catch { return []; }
      this.expireCommands(row.id, workerId);
      let command = this.command(row.id);
      if (automatic || command && !["queued", "delivering"].includes(command.status)) command = undefined;
      if (command) {
        try { this.authorizeProducts(row.id,authorizeProduct,true); }
        catch { command = undefined; }
      }
      if (!this.workOpen(row.id)) command = undefined;
      const snapshot = row.native_snapshot_json ? JSON.parse(row.native_snapshot_json) as NativeSnapshot : undefined;
      const settings = this.settingsState(row);
      // A downgraded worker must not send a reply while silently dropping the
      // person's pending choices. The reply remains cancellable in the console.
      if (!allowSettings && settings.revision > settings.settled) command = undefined;
      let mayAdjust = allowSettings && !automatic && enabled.has(row.agent_kind) && settings.revision > settings.settled
        && this.overlay(accountId, row.id, false).settings.adjustable;
      if (mayAdjust) {
        try { assertExternalExecution(this.store.database, row.id); this.authorizeProducts(row.id,authorizeProduct,true); }
        catch { mayAdjust = false; }
      }
      return [{ id: row.id, agentKind: row.agent_kind, sessionRef: row.session_ref, status: snapshot?.status ?? "unavailable",
        lifecycle: "keep", occupiesExecutionSlot: false, externalBindingGeneration: row.native_generation,
        ...(automatic ? { externalAutoConnect: true } : {}),
        ...(mayAdjust ? { desiredSettings: { ...settings.desired, revision: settings.revision }, appliedSettingsRevision: settings.settled } : {}),
        ...(command ? { command } : {}) }];
    });
  }
  recordSnapshot(input: { accountId: string; nodeId: string; sessionId: string; generation: number; workerId: string;
    status: AgentSessionStatus; messages: readonly AgentSessionMessageInput[]; activities?: readonly AgentSessionActivity[]; turnState: AgentSessionTurnState;
    error?: string; sourceArchived?: boolean; commandId?: string; commandStatus?: "delivering" | "delivery_unknown" | "delivered" | "failed"; commandError?: string;
    autoConnect?: boolean; nativeSessionRef?: string; supportsAttachments?: boolean;
    settingsSupport?: readonly SettingsField[]; mode?: string; model?: string; effort?: string;
    settingsRevision?: number; settingsError?: string },
  authorizeProduct: (id: string, execute: boolean) => void): void {
    this.store.database.transaction(() => {
      let row = this.row(input.accountId, input.sessionId);
      let generation = input.generation;
      if (input.autoConnect) {
        if (!row.native_auto_connect || row.ref_kind !== "native" || row.session_ref !== input.nativeSessionRef || row.archived_at
          || input.commandId || input.commandStatus) throw notFound("Automatic native connection");
        this.authorizeProducts(row.id,authorizeProduct,true);
        if (!this.workOpen(row.id)) throw conflict("agent_session_work_finished", "The linked work is done.");
        if (row.native_node_id === null && row.native_generation === input.generation) {
          // Probes cannot start a CLI or send input. Only the exact source's
          // verified history can admit a read-only node; failed probes never steal a binding.
          const historyOnly = row.agent_kind === "codex" && input.status === "unavailable" && input.messages.length > 0 && !input.sourceArchived;
          if (!historyOnly && (!["active", "idle", "stalled"].includes(input.status) || input.error || input.sourceArchived)) {
            // A failed probe cannot claim a node or publish unrelated source text.
            const node = this.db.prepare("SELECT agents_json FROM nodes WHERE id=? AND account_id=? AND revoked_at IS NULL").get(input.nodeId, input.accountId) as { agents_json: string } | undefined;
            if (!node || !(JSON.parse(node.agents_json) as { kind: string }[]).some(agent => agent.kind === row.agent_kind)) throw notFound("Node");
            const detail = input.error ?? "";
            const reason = /超时|timed? ?out/i.test(detail) ? "读取原生会话超时"
              : /未.*加载|notLoaded/i.test(detail) ? "原生会话未在节点运行时加载"
              : /identity|身份/i.test(detail) ? "原生会话身份核对失败"
              : /通道|socket|connect|握手/i.test(detail) ? "节点无法连接原生控制通道"
              : "节点未能读取原生会话";
            this.db.prepare("UPDATE external_agent_sessions SET native_snapshot_json=?, native_synced_at=? WHERE id=?")
              .run(JSON.stringify({status:"unavailable",turnState:{},error:`${reason}。请确认来源客户端和节点控制通道可用，或选择节点重新同步。`}), new Date().toISOString(), row.id);
            return;
          }
          this.connect(input.accountId, input.sessionId, input.nodeId);
          row = this.row(input.accountId, input.sessionId);
        }
        if (row.native_node_id !== input.nodeId || row.native_generation !== input.generation + 1) throw notFound("Automatic native connection");
        generation = row.native_generation;
      }
      if (row.native_node_id !== input.nodeId || row.native_generation !== generation || row.archived_at) throw notFound("Native binding");
      this.authorizeProducts(row.id,authorizeProduct,Boolean(input.commandId));
      if (Boolean(input.commandId) !== Boolean(input.commandStatus)) throw invalidInput("A command ID and status must be reported together.");
      if (input.commandStatus === "delivering" && !this.workOpen(row.id)) throw conflict("agent_session_work_finished", "The linked work is done.");
      if (input.messages.length > 2000) throw invalidInput("Too many native messages.");
      const now = new Date().toISOString(); let changed = false;
      observeMessageTimes(this.db, `external:${row.id}`, input.messages, now);
      const clocks = this.db.prepare("SELECT activity_at,unread_at FROM external_agent_sessions WHERE id=?").get(row.id) as { activity_at: string; unread_at: string | null };
      const clock = new Date(Math.max(Date.now(), Date.parse(clocks.activity_at) + 1, clocks.unread_at ? Date.parse(clocks.unread_at) + 1 : 0)).toISOString();
      const storedUnreadMessages = (this.db.prepare("SELECT payload_json FROM external_native_messages WHERE session_id=?").all(row.id) as { payload_json: string }[])
        .map(message => JSON.parse(message.payload_json) as AgentSessionMessageInput);
      const previousSnapshot = row.native_snapshot_json ? JSON.parse(row.native_snapshot_json) as { status?: string } : undefined;
      const unreadEvent = observeSessionUnread(this.store.database, {
        key: `external:${row.id}`, previousStatus: previousSnapshot?.status ?? "unavailable", status: input.status,
        now: clock, stored: storedUnreadMessages, messages: input.messages,
      });
      let position = (this.db.prepare("SELECT COALESCE(MAX(position),-1) AS position FROM external_native_messages WHERE session_id=?").get(row.id) as { position: number }).position;
      for (const message of input.messages.filter(isConversationMessage)) {
        if (!message.sourceId || message.sourceId.length > 200 || message.text.length > 4_000_000) throw invalidInput("Invalid native message.");
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
      const activities = input.activities ?? [];
      if (activities.length > 100 || activities.some((activity) => !activity.id || activity.id.length > 200
        || !activity.title || activity.title.length > 500 || (activity.detail?.length ?? 0) > 500
        || (activity.startedAt !== undefined && (!Number.isFinite(Date.parse(activity.startedAt))
          || Date.parse(activity.startedAt) > Date.now() + 60_000)))) throw invalidInput("Invalid native activities.");
      if (input.settingsSupport !== undefined && (!Array.isArray(input.settingsSupport) || input.settingsSupport.length > 3
        || input.settingsSupport.some((field) => !["mode", "model", "effort"].includes(field)))) throw invalidInput("Invalid settings support.");
      const settings = this.settingsState(row);
      if (input.settingsRevision !== undefined) {
        if (!Number.isSafeInteger(input.settingsRevision) || input.settingsRevision < 1 || input.settingsRevision > settings.revision) throw invalidInput("Invalid settings revision.");
        this.authorizeProducts(row.id,authorizeProduct,true);
        assertExternalExecution(this.store.database, row.id);
        if (input.settingsRevision > settings.settled) {
          settings.settled = input.settingsRevision;
          if (input.settingsError) settings.error = input.settingsError; else delete settings.error;
          // Acknowledgement is not proof that omitted values equal the request.
          // Sources may normalize a variant or change in their original client.
          if (!input.settingsError && input.settingsRevision === settings.revision) settings.values = {
            ...(input.mode ? { mode: input.mode } : {}), ...(input.model ? { model: input.model } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
          };
          this.db.prepare("UPDATE external_agent_sessions SET native_settings_json=? WHERE id=?").run(JSON.stringify(settings), row.id);
        }
      }
      const snapshot = JSON.stringify({ ...(input.settingsSupport ? { settingsSupport: input.settingsSupport } : {}),
        ...(input.mode ? { mode: input.mode } : {}), ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}), supportsAttachments: input.supportsAttachments === true, status: input.status, turnState: input.turnState, activities, ...(input.error ? { error: input.error } : {}), ...(input.sourceArchived ? { sourceArchived: true } : {}) });

      this.db.prepare(`UPDATE external_agent_sessions SET native_snapshot_json=?,native_synced_at=?,
        activity_at=CASE WHEN ? THEN ? ELSE activity_at END, unread_at=CASE WHEN ? THEN ? ELSE unread_at END WHERE id=?`)
        .run(snapshot, now, changed ? 1 : 0, clock, unreadEvent ? 1 : 0, clock, row.id);
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
      if (input.commandStatus === "delivered" || input.commandStatus === "failed") {
        autoArchiveFinishedConversations(this.store.database, input.accountId, undefined, [input.sessionId]);
      }
    });
  }
}
