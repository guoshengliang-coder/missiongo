import { AgentSessionStore, type AgentSessionListItem, type AgentSessionSnapshot } from "./agent-session-store.js";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";
import { ExternalNativeSessionStore } from "./external-native-session-store.js";
import { conflict, invalidInput, notFound } from "./errors.js";
import type { MissionGoStore } from "./store.js";

interface IdentityRow { id: string; agent: string; ref: string | null; node: string | null }

/** A read-time projection: original records, OAuth ownership and control channels stay intact. */
export class AgentConsoleSessions {
  constructor(private readonly store: MissionGoStore, private readonly dispatch: AgentSessionStore,
    private readonly external: ExternalAgentSessionStore) {}

  groups(accountId: string): AgentSessionListItem[][] {
    const db = this.store.database.connection;
    const identities = db.prepare(`SELECT COALESCE(s.id, 'dispatch:' || d.id) AS id,
      d.agent_kind AS agent, s.agent_session_ref AS ref, d.node_id AS node
      FROM dispatches d LEFT JOIN agent_sessions s ON s.dispatch_id=d.id WHERE d.account_id=?
      UNION ALL SELECT id,agent_kind,CASE WHEN ref_kind='native' THEN session_ref END,native_node_id
      FROM external_agent_sessions WHERE account_id=?`).all(accountId, accountId) as unknown as IdentityRow[];
    const rows = [...this.dispatch.listForAccount(accountId, identities.length + 1),
      ...this.external.listForAccount(accountId, identities.length + 1)];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const nodes = new Map<string, Set<string>>();
    for (const identity of identities) {
      if (!identity.ref || byId.get(identity.id)?.managedExecution) continue;
      const key = JSON.stringify([identity.agent, identity.ref]);
      if (identity.node) nodes.set(key, new Set([...(nodes.get(key) ?? []), identity.node]));
    }
    const groups = new Map<string, AgentSessionListItem[]>();
    for (const identity of identities) {
      const row = byId.get(identity.id);
      if (!row) continue;
      const nativeKey = JSON.stringify([identity.agent, identity.ref]);
      const knownNodes = nodes.get(nativeKey) ?? new Set<string>();
      // An unbound ID cannot pick between different nodes carrying that ID.
      const node = identity.node ?? (knownNodes.size === 1 ? [...knownNodes][0] : null);
      const key = !identity.ref || row.managedExecution || (!identity.node && knownNodes.size > 1)
        ? identity.id : JSON.stringify([nativeKey, node]);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups.values()].map((group) => group.sort((a, b) => {
      const rank = (row: AgentSessionListItem) => {
        if (row.source !== "external") return !row.archivedAt
          && !["failed", "unavailable", "suspended"].includes(row.status) ? 0 : 2;
        return !row.archivedAt && row.nativeConnection?.state === "connected" ? 1
          : row.nativeConnection?.nodeId ? 3 : 4;
      };
      // A resumed native thread can have an older archived hand-off. Use its live channel.
      return rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
    }));
  }

  members(accountId: string, id: string): AgentSessionListItem[] {
    const group = this.groups(accountId).find((group) => group.some((row) => row.id === id || row.dispatchId === id));
    if (!group) throw notFound("Agent session");
    return group;
  }

  list(accountId: string): AgentSessionListItem[] {
    return this.groups(accountId).map((group) => this.summary(group))
      .sort((a, b) => b.activityAt.localeCompare(a.activityAt) || b.id.localeCompare(a.id)).slice(0, 100);
  }

  private summary(group: AgentSessionListItem[]): AgentSessionListItem {
    const primary = group[0]!;
    if (group.length === 1) return primary;
    const latest = [...group].sort((a, b) => b.activityAt.localeCompare(a.activityAt))[0]!;
    const attention = [...group].filter((row) => row.needsAttention)
      .sort((a, b) => b.activityAt.localeCompare(a.activityAt))[0]?.attention ?? primary.attention;
    const unreadAt = group.flatMap((row) => row.unreadAt ? [row.unreadAt] : []).sort().at(-1);
    // Archive and reply state belong to the control channel, including old source-side archives.
    return { ...primary,
      relatedSessionIds: group.map((row) => row.id),
      items: [...new Map(group.flatMap((row) => row.items).map((item) => [item.key, item])).values()],
      activityAt: latest.activityAt, updatedAt: group.map((row) => row.updatedAt).sort().at(-1)!,
      ...(latest.latestMessage ? { latestMessage: latest.latestMessage } : {}),
      attention, needsAttention: attention.state === "needed", waitingForReply: attention.state === "needed",
      unread: group.some((row) => row.unread), ...(unreadAt ? { unreadAt } : {}),
    };
  }

  withMessages(accountId: string, id: string, primary: AgentSessionSnapshot): AgentSessionSnapshot {
    const group = this.members(accountId, id);
    if (group.length === 1) return primary;
    const messages = new Map<string, AgentSessionSnapshot["messages"][number]>();
    // The requested control channel wins when both mirrors carry the same native message.
    const rows = [...group].sort((a, b) => Number(b.id === id) - Number(a.id === id));
    for (const row of rows) {
      const snapshot = row.id === id ? primary : row.source === "external"
        ? this.external.getForAccount(accountId, row.id) : this.dispatch.getForAccount(accountId, row.id);
      for (const message of snapshot.messages) {
        const key = JSON.stringify([message.role, message.sourceId ?? message.id]);
        if (!messages.has(key)) messages.set(key, message);
      }
    }
    return { ...primary, updatedAt: group.map((row) => row.updatedAt).sort().at(-1)!,
      messages: [...messages.values()].sort((a, b) => (a.occurredAt ?? "").localeCompare(b.occurredAt ?? "")) };
  }

  markRead(accountId: string, id: string, through: string): void {
    const group = this.members(accountId, id);
    const latest = group.flatMap((row) => row.unreadAt ? [row.unreadAt] : []).sort().at(-1);
    if (!Number.isFinite(Date.parse(through)) || new Date(through).toISOString() !== through || !latest || through > latest) {
      throw invalidInput("through must name an observed unread timestamp.");
    }
    this.store.database.transaction(() => {
      for (const row of group) {
        if (!row.unreadAt) continue;
        const clock = through < row.unreadAt ? through : row.unreadAt;
        if (row.source === "external") this.external.markRead(accountId, row.id, clock);
        else this.dispatch.markRead(accountId, row.dispatchId!, clock);
      }
    });
  }

  setArchived(accountId: string, id: string, archived: boolean): void {
    const group = this.members(accountId, id);
    this.store.database.transaction(() => {
      for (const row of group) {
        if (row.source === "external") {
          if (archived) new ExternalNativeSessionStore(this.store).beforeArchive(accountId, row.id);
          this.external.setArchived(accountId, row.id, archived);
        } else if (row.agentSessionId) this.dispatch.setArchived(accountId, row.id, archived);
        else throw conflict("agent_session_not_started", "This dispatch has no session to archive.");
      }
    });
  }

  dismissAttention(accountId: string, id: string, revision: string): void {
    const group = this.members(accountId, id);
    if (this.summary(group).attention.revision !== revision) throw conflict("agent_attention_changed", "New progress arrived; reload before dismissing.");
    const row = group.find((row) => row.attention.revision === revision)!;
    if (row.source === "external") this.external.dismissAttention(accountId, row.id, revision);
    else this.dispatch.dismissAttention(accountId, row.id, revision);
  }
}
