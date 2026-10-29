import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { localArtifactPath, type AgentArtifactBundle, type AgentArtifactState } from "@missiongo/domain";
import { z } from "zod";

import type { MissionGoDatabase } from "./storage/database.js";
import { invalidInput, notFound } from "./errors.js";

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  html: "text/html", htm: "text/html", md: "text/markdown", txt: "text/plain", log: "text/plain", csv: "text/csv",
  json: "application/json", pdf: "application/pdf", css: "text/css", js: "text/javascript", mjs: "text/javascript",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
};
const fileSchema = z.object({ name: z.string().min(1).max(1024), contentType: z.string().max(100), base64: z.string().max(28 * 1024 * 1024) }).strict();
const bundleSchema = z.object({ entry: z.string().min(1).max(1024), files: z.array(fileSchema).min(1).max(64) }).strict();
interface Row {
  id: string; session_id: string; account_id: string; node_id: string | null; binding_session_id: string | null; session_ref: string | null; agent_kind: string | null;
  source_id: string; href: string; status: AgentArtifactState["status"]; error: string | null;
}
interface Binding { binding_session_id: string; node_id: string; session_ref: string; agent_kind: string }

export function validateArtifactBundle(value: unknown): AgentArtifactBundle {
  const parsed = bundleSchema.safeParse(value);
  if (!parsed.success) throw invalidInput("Invalid artifact bundle.");
  const bundle = parsed.data;
  const names = new Set<string>();
  let total = 0;
  for (const file of bundle.files) {
    if (file.name.startsWith("/") || (/[\\?#]/.test(file.name) || [...file.name].some((char) => char.charCodeAt(0) < 32))
      || file.name.split("/").some((part) => !part || part.startsWith(".")) || names.has(file.name)) throw invalidInput("Invalid artifact resource path.");
    names.add(file.name);
    const extension = file.name.split(".").at(-1)!.toLowerCase();
    if (TYPES[extension] !== file.contentType) throw invalidInput("Unsupported artifact resource type.");
    const bytes = Buffer.from(file.base64, "base64");
    if (!bytes.length || bytes.length > 20 * 1024 * 1024 || bytes.toString("base64") !== file.base64) throw invalidInput("Invalid artifact bytes.");
    total += bytes.length;
  }
  if (total > 32 * 1024 * 1024 || !names.has(bundle.entry)
    || /\.(?:css|m?js|woff2?|ttf)$/i.test(bundle.entry)) throw invalidInput("Invalid artifact entry or bundle size.");
  return bundle;
}

/** Durable, account/session-scoped copies. The API never accepts a free-form node file request. */
export class AgentArtifacts {
  constructor(private readonly database: MissionGoDatabase, private readonly root: string) {}
  private get db() { return this.database.connection; }

  binding(accountId: string, sessionId: string): Binding | undefined {
    return this.db.prepare(`SELECT s.id AS binding_session_id,s.node_id,s.agent_session_ref AS session_ref,s.agent_kind FROM agent_sessions s
      JOIN dispatches d ON d.id=s.dispatch_id JOIN nodes n ON n.id=s.node_id
      WHERE s.id=? AND d.account_id=? AND n.account_id=? AND n.revoked_at IS NULL
      UNION ALL SELECT s.id AS binding_session_id,s.native_node_id AS node_id,s.session_ref,s.agent_kind FROM external_agent_sessions s
      JOIN nodes n ON n.id=s.native_node_id WHERE s.id=? AND s.account_id=? AND n.account_id=?
      AND s.ref_kind='native' AND n.revoked_at IS NULL`)
      .get(sessionId, accountId, accountId, sessionId, accountId, accountId) as Binding | undefined;
  }

  saved(accountId: string, sessionId: string, sourceId: string, href: string): AgentArtifactState | undefined {
    const row = this.db.prepare("SELECT * FROM agent_artifacts WHERE account_id=? AND session_id=? AND source_id=? AND href=? AND status='ready'")
      .get(accountId, sessionId, sourceId, href) as Row | undefined;
    return row ? this.state(row) : undefined;
  }

  request(accountId: string, sessionId: string, sourceId: string, href: string, binding?: Binding): AgentArtifactState {
    if (!localArtifactPath(href)) throw invalidInput("Not a local artifact link.");
    const previous = this.db.prepare("SELECT * FROM agent_artifacts WHERE session_id=? AND account_id=? AND source_id=? AND href=?")
      .get(sessionId, accountId, sourceId, href) as Row | undefined;
    if (previous?.status === "ready") return this.state(previous);
    const now = new Date().toISOString();
    const id = previous?.id ?? randomUUID();
    this.db.prepare(`INSERT INTO agent_artifacts(id,session_id,account_id,node_id,binding_session_id,session_ref,agent_kind,source_id,href,status,error,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,error=excluded.error,
      node_id=excluded.node_id,binding_session_id=excluded.binding_session_id,session_ref=excluded.session_ref,agent_kind=excluded.agent_kind,updated_at=excluded.updated_at`)
      .run(id, sessionId, accountId, binding?.node_id ?? null, binding?.binding_session_id ?? null, binding?.session_ref ?? null, binding?.agent_kind ?? null,
        sourceId, href, binding ? "pending" : "failed", binding ? null : "node_unavailable", now, now);
    return this.get(accountId, sessionId, id);
  }

  get(accountId: string, sessionId: string, id: string): AgentArtifactState {
    const row = this.db.prepare("SELECT * FROM agent_artifacts WHERE id=? AND account_id=? AND session_id=?").get(id, accountId, sessionId) as Row | undefined;
    if (!row) throw notFound("Agent artifact");
    return this.state(row);
  }

  private state(row: Row): AgentArtifactState {
    return { id: row.id, status: row.status, filename: basename(localArtifactPath(row.href)!), ...(row.error ? { error: row.error } : {}) };
  }

  jobs(accountId: string, nodeId: string) {
    const rows = this.db.prepare("SELECT * FROM agent_artifacts WHERE account_id=? AND node_id=? AND status='pending' ORDER BY created_at LIMIT 4")
      .all(accountId, nodeId) as unknown as Row[];
    return rows.flatMap((row) => {
      const binding = this.binding(accountId, row.binding_session_id ?? row.session_id);
      if (!binding || binding.node_id !== nodeId || binding.session_ref !== row.session_ref) {
        this.db.prepare("UPDATE agent_artifacts SET status='failed',error='node_unavailable' WHERE id=?").run(row.id);
        return [];
      }
      return [{ id: row.id, sessionId: row.session_id, sessionRef: row.session_ref!, agentKind: row.agent_kind!, sourceId: row.source_id, href: row.href }];
    });
  }

  rejectJob(id: string): void {
    this.db.prepare("UPDATE agent_artifacts SET status='failed',error='node_unavailable' WHERE id=? AND status='pending'").run(id);
  }

  authorizeJob(accountId: string, nodeId: string, id: string): Row {
    const row = this.db.prepare("SELECT * FROM agent_artifacts WHERE id=? AND account_id=? AND node_id=? AND status='pending'").get(id, accountId, nodeId) as Row | undefined;
    const binding = row && this.binding(accountId, row.binding_session_id ?? row.session_id);
    if (!row || !binding || binding.node_id !== nodeId || binding.session_ref !== row.session_ref) throw notFound("Agent artifact job");
    return row;
  }

  async complete(accountId: string, nodeId: string, id: string, value: unknown): Promise<void> {
    this.authorizeJob(accountId, nodeId, id);
    const body = z.object({ error: z.enum(["file_missing", "unsupported", "reference_missing", "file_denied", "too_large", "resource_missing", "node_unavailable"]).optional(), bundle: bundleSchema.optional() }).strict().safeParse(value);
    if (!body.success || Boolean(body.data.error) === Boolean(body.data.bundle)) throw invalidInput("Report one artifact result.");
    if (body.data.bundle) {
      const bundle = validateArtifactBundle(body.data.bundle);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temp = join(this.root, `${id}-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify(bundle), { mode: 0o600, flag: "wx" });
        // Binding may have been revoked while writing. Check again before publishing.
        this.authorizeJob(accountId, nodeId, id);
        await rename(temp, join(this.root, `${id}.json`));
      } finally { await unlink(temp).catch(() => undefined); }
    }
    this.db.prepare("UPDATE agent_artifacts SET status=?,error=?,updated_at=? WHERE id=?")
      .run(body.data.bundle ? "ready" : "failed", body.data.error ?? null, new Date().toISOString(), id);
  }

  async bundle(accountId: string, sessionId: string, id: string): Promise<AgentArtifactBundle> {
    if (this.get(accountId, sessionId, id).status !== "ready") throw notFound("Saved agent artifact");
    return JSON.parse(await readFile(join(this.root, `${id}.json`), "utf8")) as AgentArtifactBundle;
  }
}

// An HTTP document has its own CSP; srcdoc would inherit the application's stricter script policy.
export const ARTIFACT_PREVIEW_POLICY = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
export const ARTIFACT_PREVIEW_SHELL = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
addEventListener('message', function receive(event) {
  if (event.source !== parent || event.data?.type !== 'missiongo-artifact-preview' || typeof event.data.html !== 'string') return;
  removeEventListener('message', receive);
  document.open(); document.write(event.data.html); document.close();
});
</script></body></html>`;
