import { randomUUID } from "node:crypto";
import type { AgentKind } from "@missiongo/domain";
import type { MissionGoDatabase } from "./storage/database.js";
import { DispatchStore, type DispatchSnapshot } from "./dispatch-store.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { conflict, invalidInput, notFound } from "./errors.js";

export interface FreeSessionConfig {
  productId: string; nodeId: string; agentKind: AgentKind; mode: string;
  model?: string; effort?: string; saveAsDefault?: boolean;
}
interface StartRow {
  dispatch_id: string; account_id: string; request_key: string; product_id: string;
  initial_text: string; session_title: string | null; config_json: string; attachment_count: number; ready: number;
}

/** A deterministic excerpt, not an LLM request. Saved once so retries keep the same name. */
export function projectSessionTitle(text: string, identity: string): string {
  const clean = text.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(clean);
  const excerpt = characters.length > 48 ? `${characters.slice(0, 48).join("")}…` : clean;
  return `${excerpt || "附件会话"} · ${identity.replace(/-/g, "").slice(0, 8)}`;
}

/** First send reserves one durable conversation. Uploads finish before the node may claim it. */
export class FreeSessionStore {
  constructor(private readonly db: MissionGoDatabase, private readonly dispatches: DispatchStore,
    private readonly sessions: AgentSessionStore) {}

  /** `title` names a conversation whose first message is machinery, not the subject (AND-449). */
  prepare(accountId: string, requestKey: string, config: FreeSessionConfig, text: string, attachmentCount = 0, title?: string): DispatchSnapshot {
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(requestKey)) throw invalidInput("A stable requestKey is required.");
    text = text.trim();
    if (!Number.isInteger(attachmentCount) || attachmentCount < 0 || attachmentCount > 10) throw invalidInput("attachmentCount must be from 0 to 10.");
    if (!text && !attachmentCount) throw invalidInput("A first message or attachment is required.");
    if (text.length > 20_000) throw invalidInput("Message is too long.");
    const configJson = JSON.stringify(config);
    return this.db.transaction(() => {
      const previous = this.db.connection.prepare("SELECT * FROM free_session_starts WHERE account_id=? AND request_key=?")
        .get(accountId, requestKey) as unknown as StartRow | undefined;
      if (previous) {
        if (previous.config_json !== configJson || previous.initial_text !== text || previous.attachment_count !== attachmentCount) throw conflict("free_session_changed", "This send already reserved a different conversation.");
        return this.dispatches.getDispatch(accountId, previous.dispatch_id);
      }
      if (attachmentCount && !this.dispatches.getNode(accountId, config.nodeId).supportsChatAttachments) {
        throw conflict("agent_node_attachments_unsupported", "Update this node before sending attachments.");
      }
      const dispatch = this.dispatches.createDispatch({ ...config, saveAsDefault: false, accountId, itemKeys: [] }, true);
      this.db.connection.prepare(`INSERT INTO free_session_starts
        (dispatch_id,account_id,request_key,product_id,initial_text,config_json,attachment_count,session_title) VALUES (?,?,?,?,?,?,?,?)`)
        .run(dispatch.id, accountId, requestKey, config.productId, text, configJson, attachmentCount,
          title?.trim() || projectSessionTitle(text, dispatch.id));
      // This reference is never sent to a node. Launch replaces it with the verified native ID.
      this.sessions.createForDispatch({ dispatchId: dispatch.id, nodeId: config.nodeId, sessionRef: `pending:${dispatch.id}` });
      this.db.connection.prepare("UPDATE agent_sessions SET status='idle' WHERE dispatch_id=?").run(dispatch.id);
      return this.dispatches.getDispatch(accountId, dispatch.id);
    });
  }

  finish(accountId: string, dispatchId: string, attachmentIds: readonly string[]): DispatchSnapshot {
    return this.db.transaction(() => {
      const row = this.db.connection.prepare("SELECT * FROM free_session_starts WHERE dispatch_id=? AND account_id=?")
        .get(dispatchId, accountId) as unknown as StartRow | undefined;
      if (!row) throw notFound("Project conversation");
      const dispatch = this.dispatches.getDispatch(accountId, dispatchId);
      if (row.ready) return dispatch; // Lost acknowledgement must not enqueue twice.
      if (dispatch.status !== "queued" || !dispatch.agentSessionId) throw conflict("dispatch_not_retryable", "This conversation cannot start.");
      if (new Set(attachmentIds).size !== row.attachment_count || attachmentIds.length !== row.attachment_count) {
        throw invalidInput("Finish uploading all first-message attachments before starting.");
      }
      const config = JSON.parse(row.config_json) as FreeSessionConfig;
      if (config.saveAsDefault) this.dispatches.setDispatchDefaults(accountId, {
        nodeId: dispatch.nodeId, agentKind: dispatch.agentKind,
        agents: { ...this.dispatches.getDispatchDefaults(accountId).agents, [dispatch.agentKind]: {
          mode: dispatch.mode, ...(dispatch.model ? { model: dispatch.model } : {}), ...(dispatch.effort ? { effort: dispatch.effort } : {}),
        } },
      });
      this.sessions.enqueue(accountId, dispatch.agentSessionId, row.initial_text, attachmentIds);
      this.db.connection.prepare("UPDATE free_session_starts SET ready=1 WHERE dispatch_id=?").run(dispatchId);
      this.dispatches.wake(dispatch.nodeId);
      return this.dispatches.getDispatch(accountId, dispatchId);
    });
  }

  stop(accountId: string, dispatchId: string): DispatchSnapshot {
    return this.db.transaction(() => {
      const dispatch = this.dispatches.cancelQueuedDispatch(accountId, dispatchId);
      this.db.connection.prepare(`UPDATE agent_session_commands SET status='cancelled',cancelled_at=?
        WHERE session_id=? AND status='queued'`).run(new Date().toISOString(), dispatch.agentSessionId ?? "");
      return dispatch;
    });
  }

  retry(accountId: string, dispatchId: string): DispatchSnapshot {
    return this.db.transaction(() => {
      const original = this.dispatches.getDispatch(accountId, dispatchId);
      const row = this.db.connection.prepare("SELECT * FROM free_session_starts WHERE dispatch_id=? AND account_id=?")
        .get(dispatchId, accountId) as unknown as StartRow | undefined;
      const session = this.db.connection.prepare("SELECT id,agent_session_ref,archived_at FROM agent_sessions WHERE dispatch_id=?").get(dispatchId) as {id:string;agent_session_ref:string;archived_at:string|null}|undefined;
      // An unconfirmed or real native session is never relaunched by this action.
      if (!row || !row.ready || !session || session.archived_at || session.agent_session_ref !== `pending:${dispatchId}`
        || !["failed", "cancelled"].includes(original.status)) {
        throw conflict("dispatch_not_retryable", "Confirm the original session state before retrying.");
      }
      const next = this.dispatches.createDispatch({ ...JSON.parse(row.config_json), accountId, itemKeys: [] }, true);
      const now = new Date().toISOString();
      this.db.connection.prepare("UPDATE free_session_starts SET request_key=? WHERE dispatch_id=?").run(randomUUID(),dispatchId);
      this.db.connection.prepare(`INSERT INTO free_session_starts
        (dispatch_id,account_id,request_key,product_id,initial_text,config_json,attachment_count,ready,session_title) VALUES (?,?,?,?,?,?,?,1,?)`)
        .run(next.id,accountId,row.request_key,row.product_id,row.initial_text,row.config_json,row.attachment_count,row.session_title);
      this.db.connection.prepare("UPDATE agent_sessions SET dispatch_id=?,agent_session_ref=?,status='idle',last_error=NULL WHERE id=?")
        .run(next.id,`pending:${next.id}`,session.id);
      this.db.connection.prepare("UPDATE agent_session_commands SET status='queued',cancelled_at=NULL WHERE session_id=? AND status='cancelled'")
        .run(session.id);
      this.db.connection.prepare("UPDATE dispatches SET archived_at=? WHERE id=?").run(now,dispatchId);
      return this.dispatches.getDispatch(accountId,next.id);
    });
  }
}
