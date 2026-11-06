import { z } from "zod";
import { completionFields } from "./completion.js";
import { MAX_RELEASE_ARTIFACTS, RELEASE_ARTIFACT_ID_PATTERN } from "./types.js";

export const releaseBatchSchema = z.object({
  productId: z.string().min(1).max(200),
  idempotencyKey: z.string().min(1).max(200),
  deployedCommit: z.string().regex(/^[0-9a-f]{40}$/),
  receiptDigest: z.string().regex(/^[0-9a-f]{64}$/),
  items: z.array(z.object({
    itemKey: z.string().regex(/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/),
    expectedRevision: z.number().int().positive(),
    developmentEventId: z.string().uuid(),
    roundKey: z.string().uuid(),
    ...completionFields,
    releases: z.array(z.object({
      artifact: z.string().regex(RELEASE_ARTIFACT_ID_PATTERN),
      version: z.string().trim().min(1).max(100),
      sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    }).strict()).min(1).max(MAX_RELEASE_ARTIFACTS),
  }).strict()).min(1).max(100),
}).strict();

/** Explicit, bounded evidence repair; no original developer or merge identity. */
export const releaseEvidenceSchema = z.object({
  productId: z.string().min(1).max(200),
  itemKey: z.string().regex(/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/),
  expectedRevision: z.number().int().positive(),
  developmentEventId: z.string().uuid(),
  roundKey: z.string().uuid(),
  ...completionFields,
  requiredArtifacts: z.array(z.string().regex(RELEASE_ARTIFACT_ID_PATTERN)).min(1).max(MAX_RELEASE_ARTIFACTS),
  idempotencyKey: z.string().min(1).max(200),
}).strict();
