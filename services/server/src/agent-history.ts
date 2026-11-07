import { isConversationMessage } from "@missiongo/domain";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentSessionSnapshot } from "./agent-session-store.js";
import type { AgentArtifacts } from "./agent-artifacts.js";
import type { MissionGoDatabase } from "./storage/database.js";
import { invalidInput, notFound } from "./errors.js";

const metadataSchema = z.object({ cursor: z.string().min(1).max(4096).nullable().optional(),
  complete: z.boolean(), error: z.enum(["unavailable", "unsupported", "node_unavailable", "too_large"]).nullable().optional() }).strict();
const messageSchema = z.object({ sourceId: z.string().min(1).max(200), turnId: z.string().max(200).nullable().optional(),
  role: z.enum(["user", "agent", "plan"]), phase: z.string().max(50).nullable().optional(), text: z.string().min(1).max(4_000_000),
  occurredAt: z.string().datetime().nullable().optional(), questions: z.array(z.object({ title: z.string().max(4000),
    header: z.string().max(4000).optional(), detail: z.string().max(512_000).optional(),
    options: z.array(z.string().max(4000)).optional(), multiSelect: z.boolean().optional(), key: z.string().max(4000).optional(),
    kind: z.enum(["text", "number", "boolean"]).optional(), placeholder: z.string().max(4000).optional(),
    custom: z.boolean().optional(), answered: z.string().max(4_000_000).optional(), withdrawn: z.boolean().optional(),
  }).strict()).max(50).nullable().optional() }).strict();
const resultSchema = z.object({ messages: z.array(messageSchema).max(2000), nextCursor: z.string().min(1).max(4096).nullable().optional(),
  error: z.enum(["unavailable", "unsupported", "node_unavailable", "too_large"]).nullable().optional() }).strict();
type Message = AgentSessionSnapshot["messages"][number];
interface PageRow { id: string; account_id: string; session_id: string; node_id: string; session_ref: string;
  cursor: string; status: "idle" | "pending" | "ready" | "failed"; result_json: string | null; next_id: string | null; error: string | null }
interface SourceRow { node_id: string; session_ref: string; next_id: string | null; error: string | null }
export interface HistoryPage { status: "pending" | "ready" | "failed"; messages: readonly Message[]; nextCursor?: string; error?: string }
export interface HistoryState { nextCursor?: string; error?: string }

/** Read-only source work is independently queued. No command, task status or native input is created here. */
export class AgentHistory {
  constructor(private readonly database: MissionGoDatabase, private readonly artifacts: AgentArtifacts) {}
  private get db() { return this.database.connection; }

  private binding(accountId: string, sessionId: string) {
    const binding = this.artifacts.binding(accountId, sessionId);
    if (!binding || !["codex","opencode","claude_code"].includes(binding.agent_kind)
      || this.db.prepare("SELECT 1 FROM agent_sessions s JOIN managed_execution_intents m ON m.id=s.dispatch_id WHERE s.id=?").get(sessionId)) {
      throw notFound("Agent history binding");
    }
    return binding;
  }

  private seed(accountId: string, sessionId: string, cursor: string): string {
    const binding = this.binding(accountId, sessionId);
    this.db.prepare(`INSERT OR IGNORE INTO agent_history_pages(id,account_id,session_id,node_id,session_ref,cursor,status,updated_at)
      VALUES (?,?,?,?,?,?,'idle',?)`).run(randomUUID(), accountId, sessionId, binding.node_id, binding.session_ref, cursor, new Date().toISOString());
    return (this.db.prepare("SELECT id FROM agent_history_pages WHERE account_id=? AND session_id=? AND node_id=? AND session_ref=? AND cursor=?")
      .get(accountId, sessionId, binding.node_id, binding.session_ref, cursor) as { id: string }).id;
  }

  observe(accountId: string, nodeId: string, sessionId: string, value: unknown): void {
    if (value === undefined) return;
    const parsed = metadataSchema.safeParse(value);
    if (!parsed.success || parsed.data.complete && (parsed.data.cursor || parsed.data.error)
      || !parsed.data.complete && !parsed.data.cursor && !parsed.data.error) throw invalidInput("Invalid history metadata.");
    const binding = this.binding(accountId, sessionId);
    if (binding.node_id !== nodeId) throw notFound("Agent history binding");
    const nextId = parsed.data.cursor ? this.seed(accountId, sessionId, parsed.data.cursor) : null;
    this.db.prepare(`INSERT INTO agent_history_sources(account_id,session_id,node_id,session_ref,next_id,error)
      VALUES (?,?,?,?,?,?) ON CONFLICT(account_id,session_id) DO UPDATE SET node_id=excluded.node_id,
      session_ref=excluded.session_ref,next_id=excluded.next_id,error=excluded.error`)
      .run(accountId, sessionId, nodeId, binding.session_ref, nextId, parsed.data.error ?? null);
  }

  private source(accountId: string, sessionId: string): SourceRow | undefined {
    const source = this.db.prepare("SELECT * FROM agent_history_sources WHERE account_id=? AND session_id=?")
      .get(accountId, sessionId) as SourceRow | undefined;
    const binding = this.artifacts.binding(accountId, sessionId);
    return source && binding?.node_id === source.node_id && binding.session_ref === source.session_ref ? source : undefined;
  }

  window(accountId: string, sessionId: string, messages: readonly Message[], before?: string): { messages: readonly Message[]; history: HistoryState } {
    let end = messages.length;
    if (before !== undefined) {
      if (!before.startsWith("stored:")) throw invalidInput("Invalid stored history cursor.");
      end = messages.findIndex(message => message.id === before.slice(7));
      if (end < 0) throw notFound("Stored history anchor");
    }
    let start = end;
    let bytes = 0;
    while (start > 0 && end - start < 50) {
      const size = Buffer.byteLength(JSON.stringify(messages[start - 1]));
      if (start < end && bytes + size > 512 * 1024) break;
      bytes += size; start--;
    }
    const page = messages.slice(start, end);
    const source = this.source(accountId, sessionId);
    const nextCursor = start > 0 ? `stored:${page[0]!.id}` : source?.next_id ?? undefined;
    return { messages: page, history: { ...(nextCursor ? { nextCursor } : {}), ...(source?.error ? { error: source.error } : {}) } };
  }

  available(accountId: string, sessionId: string) {
    const source=this.source(accountId,sessionId);
    if(!source) return {status:"unavailable",error:"unsupported_or_not_synchronized",cursors:[] as string[]};
    return {status:source.error ? "failed" : source.next_id ? "ready" : "complete",
      cursors:source.next_id ? [source.next_id] : [], ...(source.next_id?{nextCursor:source.next_id}:{}),
      ...(source.error?{error:source.error}:{})};
  }

  incomplete(accountId: string, sessionId: string): boolean {
    const source=this.source(accountId,sessionId);
    if(!source) return false;
    if(source.error) return true;
    let id=source.next_id;
    const seen=new Set<string>();
    while(id) {
      if(seen.has(id)) return true;
      seen.add(id);
      const row=this.page(accountId,sessionId,id);
      if(row.status!=="ready"||row.error) return true;
      id=row.next_id;
    }
    return false;
  }

  get(accountId: string, sessionId: string, id: string): HistoryPage {
    const row = this.page(accountId, sessionId, id);
    return { status: row.status === "idle" ? "pending" : row.status,
      messages: row.result_json ? (JSON.parse(row.result_json) as Message[]).filter(isConversationMessage).map(message=>({...message,
        ...(message.questions?{questions:message.questions.map(question=>({...question,withdrawn:true}))}:{})})) : [],
      ...(row.next_id ? { nextCursor: row.next_id } : {}), ...(row.error ? { error: row.error } : {}) };
  }

  request(accountId: string, sessionId: string, id: string): HistoryPage {
    this.page(accountId, sessionId, id);
    this.db.prepare("UPDATE agent_history_pages SET status='pending',error=NULL,updated_at=? WHERE id=? AND status IN ('idle','failed')")
      .run(new Date().toISOString(), id);
    return this.get(accountId, sessionId, id);
  }

  private page(accountId: string, sessionId: string, id: string): PageRow {
    const row = this.db.prepare("SELECT * FROM agent_history_pages WHERE id=? AND account_id=? AND session_id=?")
      .get(id, accountId, sessionId) as PageRow | undefined;
    const binding = this.binding(accountId, sessionId);
    if (!row || binding.node_id !== row.node_id || binding.session_ref !== row.session_ref) throw notFound("Agent history page");
    return row;
  }

  jobs(accountId: string, nodeId: string) {
    const rows = this.db.prepare("SELECT * FROM agent_history_pages WHERE account_id=? AND node_id=? AND status='pending' ORDER BY updated_at LIMIT 2")
      .all(accountId, nodeId) as unknown as PageRow[];
    return rows.flatMap(row => {
      try { this.page(accountId, row.session_id, row.id); }
      catch { this.reject(row.id); return []; }
      return [{ id: row.id, sessionId: row.session_id, sessionRef: row.session_ref, agentKind: this.binding(accountId,row.session_id).agent_kind, cursor: row.cursor }];
    });
  }

  authorizeJob(accountId: string, nodeId: string, id: string): PageRow {
    const row = this.db.prepare("SELECT * FROM agent_history_pages WHERE id=? AND account_id=? AND node_id=?")
      .get(id, accountId, nodeId) as PageRow | undefined;
    if (!row) throw notFound("Agent history job");
    this.page(accountId, row.session_id, id);
    return row;
  }

  reject(id: string): void {
    this.db.prepare("UPDATE agent_history_pages SET status='failed',error='node_unavailable' WHERE id=? AND status='pending'").run(id);
  }

  complete(accountId: string, nodeId: string, id: string, value: unknown): void {
    const row = this.authorizeJob(accountId, nodeId, id);
    if (row.status === "ready") return; // Lost response retries are idempotent.
    if (row.status !== "pending") throw invalidInput("History page was not requested.");
    const parsed = resultSchema.safeParse(value);
    if (!parsed.success) throw invalidInput("Invalid history page result.");
    const data = parsed.data;
    if (data.nextCursor === row.cursor) throw invalidInput("History cursor did not advance.");
    if (data.error && (data.messages.length || data.nextCursor)) throw invalidInput("History error cannot contain a page.");
    const messages = data.messages.filter(isConversationMessage).map(message => ({ ...message, id: `history:${message.sourceId}`,
      occurredAt: message.occurredAt ?? "" }));
    const payload = JSON.stringify(messages);
    if (Buffer.byteLength(payload) > 30 * 1024 * 1024) throw invalidInput("History page is too large.");
    this.database.transaction(() => {
      const nextId = data.nextCursor ? this.seed(accountId, row.session_id, data.nextCursor) : null;
      let candidate = nextId;
      const seen = new Set<string>();
      while (candidate && !seen.has(candidate)) {
        if (candidate === id) throw invalidInput("History cursor cycle.");
        seen.add(candidate);
        candidate = (this.db.prepare("SELECT next_id FROM agent_history_pages WHERE id=?").get(candidate) as { next_id: string | null } | undefined)?.next_id ?? null;
      }
      this.db.prepare("UPDATE agent_history_pages SET status=?,result_json=?,next_id=?,error=?,updated_at=? WHERE id=?")
        .run(data.error ? "failed" : "ready", payload, nextId, data.error ?? null, new Date().toISOString(), id);
    });
  }

  /** Saved historical messages also authorize their own output links. */
  cachedMessages(accountId: string, sessionId: string): readonly Message[] {
    const binding = this.artifacts.binding(accountId, sessionId);
    if (!binding) return [];
    const rows = this.db.prepare("SELECT result_json FROM agent_history_pages WHERE account_id=? AND session_id=? AND node_id=? AND session_ref=? AND status='ready' ORDER BY rowid DESC")
      .all(accountId, sessionId, binding.node_id, binding.session_ref) as { result_json: string }[];
    return rows.flatMap(row => JSON.parse(row.result_json) as Message[]);
  }
}
