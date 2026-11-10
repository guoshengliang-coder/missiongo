import { createHash } from "node:crypto";
import { z } from "zod";
import type { MissionGoStore } from "./store.js";
import type { CompletionReference, DeliveryExplanation } from "@missiongo/contracts";
import { conflict, invalidInput, notFound } from "./errors.js";
import { isReleaseArtifactId, MAX_RELEASE_ARTIFACTS } from "./types.js";

export const MAX_OBSERVATION_DIAGNOSTICS = 20;
type ObservationDiagnostic = {
  developmentEventId: string;
  status: "historical" | "integration_missing" | "repository_unavailable" | "not_found" | "invalid_observation" | "read_failed" | "available";
  observationId?: string;
};

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

  /** Locator hints only. No network access, coverage assertion, receipt or status write. */
  diagnostics(productId: string, deliveries: ReturnType<MissionGoStore["getDeliveryRecords"]>, explanations: readonly DeliveryExplanation[]) {
    const current = new Set(explanations.filter(row => row.applicability === "current").map(row => row.developmentEventId));
    const entries: Array<{id: string; completion?: CompletionReference | undefined}> = [...deliveries];
    const known = new Set(entries.map(row => row.id));
    for (const explanation of explanations) if (!known.has(explanation.developmentEventId)) {
      entries.push({id: explanation.developmentEventId});
      known.add(explanation.developmentEventId);
    }
    const observations = new Map<string, ReleaseObservation>();
    const byRepository = new Map<string, { status: "not_found" | "invalid_observation" | "read_failed" | "available"; observationId?: string }>();
    const items: ObservationDiagnostic[] = entries.slice(-MAX_OBSERVATION_DIAGNOSTICS).map(delivery => {
      const base = { developmentEventId: delivery.id };
      if (!current.has(delivery.id)) return { ...base, status: "historical" };
      if (!delivery.completion) return { ...base, status: "integration_missing" };
      const repository = completionRepository(delivery.completion);
      if (!repository) return { ...base, status: "repository_unavailable" };
      let result = byRepository.get(repository);
      if (!result) {
        try {
          const raw = this.latest(productId, delivery.completion);
          const parsed = releaseObservationSchema.safeParse(raw);
          if (raw === undefined) result = { status: "not_found" };
          else if (!parsed.success || parsed.data.repository !== repository || parsed.data.environment !== "production") result = { status: "invalid_observation" };
          else {
            // Project onto the bounded public schema; never expose row metadata or extra JSON fields.
            observations.set(parsed.data.id, parsed.data);
            result = { status: "available", observationId: parsed.data.id };
          }
        } catch (error) {
          // Neither malformed JSON nor a failed read proves that publication is missing.
          result = { status: error instanceof SyntaxError ? "invalid_observation" : "read_failed" };
        }
        byRepository.set(repository, result);
      }
      return { ...base, ...result };
    });
    return {
      unverified: true,
      notice: "Untrusted repository-level observations, not verified delivery coverage. Independently verify integration and every required artifact before explicit handover. Reading never changes item status.",
      items, observations: [...observations.values()], total: entries.length,
      limit: MAX_OBSERVATION_DIAGNOSTICS, truncated: entries.length > items.length,
    };
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
      // Publication history is passive; uploads never enqueue status corrections.
      return {id:input.id,accepted:true,duplicate:false,superseded};
    });
  }
}
