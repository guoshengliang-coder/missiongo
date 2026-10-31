import { createHash } from "node:crypto";
import { z } from "zod";
import type { MissionGoStore } from "./store.js";
import type { CompletionReference } from "@missiongo/contracts";
import { conflict, invalidInput, notFound } from "./errors.js";
import { isReleaseArtifactId, MAX_RELEASE_ARTIFACTS } from "./types.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const https = z.string().max(2000).refine(value => {
  try { const u = new URL(value); return u.protocol === "https:" && !!u.hostname && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
});
export const releaseObservationSchema = z.object({
  schemaVersion: z.literal(2), id: z.uuid(),
  repository: https.refine(value => /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(value)
    && !value.endsWith(".git") && new URL(value).href === value),
  environment: z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/),
  observedAt: z.iso.datetime({offset: true}),
  releases: z.array(z.object({
    artifact: z.string().refine(isReleaseArtifactId), version: z.string().trim().min(1).max(100), sourceCommit: sha,
    proof: z.discriminatedUnion("kind", [z.object({kind:z.literal("health"),url:https}),
      z.object({kind:z.literal("sha256"),url:https,sha256:z.string().regex(/^[a-f0-9]{64}$/)})]),
  })).max(MAX_RELEASE_ARTIFACTS),
}).refine(value => new Set(value.releases.map(r => r.artifact)).size === value.releases.length, "Duplicate release artifacts.");
export type ReleaseObservation = z.infer<typeof releaseObservationSchema>;

export function completionRepository(completion: CompletionReference): string | undefined {
  if (!("url" in completion)) return undefined;
  const u = new URL(completion.url);
  const suffix = completion.kind === "gitlab" ? /\/-\/merge_requests\/\d+\/?$/ : /\/pull\/\d+\/?$/;
  return u.origin + u.pathname.replace(suffix, "");
}

/** Unverified publication observations, shared by a product. Never transition an item on upload. */
export class ReleaseObservations {
  constructor(readonly store: MissionGoStore) {}
  private get db() { return this.store.database.connection; }
  latest(productId: string, completion: CompletionReference): ReleaseObservation | undefined {
    const repository = completionRepository(completion);
    if (!repository) return undefined;
    const row = this.db.prepare(`SELECT payload_json FROM release_observations
      WHERE product_id=? AND repository=? AND environment='production' ORDER BY observed_at DESC LIMIT 1`)
      .get(productId,repository) as {payload_json:string} | undefined;
    return row ? JSON.parse(row.payload_json) as ReleaseObservation : undefined;
  }
  upload(productId: string, repoPath: string, raw: unknown, source: {nodeId:string;accountId:string}) {
    const parsed = releaseObservationSchema.safeParse(raw);
    if (!parsed.success) throw invalidInput("Invalid publication observation.");
    const input = parsed.data;
    if (!this.db.prepare("SELECT 1 FROM node_product_repos WHERE node_id=? AND product_id=? AND repo_path=?")
      .get(source.nodeId,productId,repoPath) || this.store.getProduct(productId).archivedAt) throw notFound("Repository mapping");
    if (Date.parse(input.observedAt) > Date.now()+60_000) throw invalidInput("Publication cannot be dated in the future.");
    // Normalize timestamp spelling before comparing chronology. Retries retain the original ID/time.
    input.observedAt = new Date(input.observedAt).toISOString();
    const json = JSON.stringify(input);
    const digest = createHash("sha256").update(json).digest("hex");
    return this.store.database.transaction(() => {
      const previous = this.db.prepare("SELECT product_id,digest FROM release_observations WHERE id=?").get(input.id) as {product_id:string;digest:string} | undefined;
      if (previous) {
        if (previous.product_id !== productId || previous.digest !== digest) throw conflict("release_id_conflict","Publication ID was already used for different content.");
        return {id:input.id,accepted:true,duplicate:true};
      }
      const latest = this.db.prepare(`SELECT observed_at FROM release_observations WHERE product_id=? AND repository=? AND environment=? ORDER BY observed_at DESC LIMIT 1`)
        .get(productId,input.repository,input.environment) as {observed_at:string} | undefined;
      if (latest?.observed_at === input.observedAt) throw conflict("release_time_conflict","Conflicting publication observations have the same timestamp; verify and record a fresh snapshot.");
      this.db.prepare(`INSERT INTO release_observations(id,product_id,repository,environment,observed_at,payload_json,digest,account_id,node_id,received_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.id,productId,input.repository,input.environment,input.observedAt,json,digest,source.accountId,source.nodeId,new Date().toISOString());
      const superseded = Boolean(latest && latest.observed_at > input.observedAt);
      if (!superseded && input.environment === "production") {
        // Durable queue only. Repository/round/permission checks and all remote IO happen later.
        this.db.prepare(`UPDATE status_handovers SET requested_at=?,retry_count=0
          WHERE item_id IN (SELECT id FROM work_items WHERE product_id=? AND status IN ('inbox','ready','in_progress','development_complete'))`)
          .run(new Date().toISOString(),productId);
      }
      return {id:input.id,accepted:true,duplicate:false,superseded};
    });
  }
}
