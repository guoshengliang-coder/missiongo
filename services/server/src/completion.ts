import { z } from "zod";
import type { CompletionReference } from "@missiongo/contracts";
import { invalidInput } from "./errors.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
function hostedUrl(value: string, kind: "github" | "gitlab"): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && (kind === "github" ? /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/
        : /^\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\/-\/merge_requests\/[1-9][0-9]*\/?$/).test(url.pathname);
  } catch { return false; }
}
export const completionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github"), url: z.string().max(500).refine(v => hostedUrl(v, "github"), "Use an HTTPS GitHub PR URL.") }).strict(),
  z.object({ kind: z.literal("gitlab"), url: z.string().max(500).refine(v => hostedUrl(v, "gitlab"), "Use an HTTPS GitLab MR URL.") }).strict(),
  z.object({ kind: z.literal("commit"), commit: sha, targetBranch: z.string().max(200)
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/).refine(v => !v.includes("..") && !v.includes("//") && !v.endsWith(".") && !v.split("/").some(s => s.endsWith(".lock"))) }).strict(),
  z.object({ kind: z.literal("manual"), commit: sha, description: z.string().trim().min(1).max(4000) }).strict(),
]);
export const completionFields = {
  completion: completionSchema.optional(),
  /** Backward compatibility for existing clients and historical timelines. */
  pullRequestUrl: z.string().min(1).max(500).startsWith("https://").optional(),
};
export function normalizeCompletion(raw: unknown): CompletionReference {
  const fields = z.object(completionFields).safeParse(raw);
  if (!fields.success) throw invalidInput("Provide a valid completion reference.");
  const input = fields.data;
  const legacy = input.pullRequestUrl;
  const value = input.completion ?? (legacy ? { kind: legacy.includes("/-/merge_requests/") ? "gitlab" : "github", url: legacy } : undefined);
  const parsed = completionSchema.safeParse(value);
  if (!parsed.success) throw invalidInput("Provide a valid completion reference (GitHub PR, GitLab MR, local commit or human confirmation).");
  const result = parsed.data;
  if (legacy !== undefined && (!("url" in result) || result.url !== legacy)) throw invalidInput("Completion reference conflicts with pullRequestUrl.");
  return "url" in result ? { ...result, url: result.url.replace(/\/$/, "") } : result;
}
export function completionPayload(completion: CompletionReference) {
  return { completion, ...("url" in completion ? { pullRequestUrl: completion.url } : {}) };
}
export function sameCompletion(a: CompletionReference, b: CompletionReference): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
