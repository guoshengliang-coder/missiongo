import { createHash } from "node:crypto";
import { z } from "zod";

const text = z.string().trim().min(1).max(4000);
export const deliveryValidationSchema = z.object({
  checks: z.array(z.object({name: z.string().trim().min(1).max(200), method:text,
    result:z.enum(["passed","failed","not_run"]), evidence:text}).strict()).min(1).max(32),
  remainingVerification:z.array(text).max(32), limitations:z.array(text).max(32),
}).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const resource = z.string().trim().min(1).max(200).refine(value =>
  !value.startsWith("/") && !value.includes("\\") && !value.includes(":") && ![...value].some(char => char.charCodeAt(0) < 32)
  && value.split("/").every(part => part.length > 0 && part !== "." && part !== ".." && !part.startsWith("~")),
  "Use safe relative resource names, never absolute paths.");
export const localChangeEvidenceSchema = z.object({
  version:z.literal(1), target:text, summary:text,
  files:z.array(z.object({name:resource,beforeSha256:hash.nullable(),afterSha256:hash.nullable(),
    sizeBytes:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict().refine(file =>
      (file.beforeSha256 !== null || file.afterSha256 !== null) && file.beforeSha256 !== file.afterSha256
      && (file.afterSha256 !== null || file.sizeBytes === 0), "Record an actual change and zero bytes for deleted files.")).min(1).max(32),
  rollback:text, validation:deliveryValidationSchema,
}).strict().refine(value => new Set(value.files.map(file=>file.name)).size === value.files.length,"Duplicate resource names.")
  .transform(value=>({...value,files:[...value.files].sort((a,b)=>a.name.localeCompare(b.name,"en"))}));
/** Input is parsed first; canonical object field order is fixed by the schemas. */
export const evidenceDigest = (value:unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type NonReleaseVerification = {
  itemKey:string; expectedRevision:number; developmentEventId:string; roundKey:string;
  completion:import("@missiongo/contracts").CompletionReference; evidenceDigest:string;
  validation:import("@missiongo/contracts").DeliveryValidation; idempotencyKey:string;
  attribution?:import("./types.js").EventAttribution;
};

/** Product-scoped historical proof, deliberately without execution identity fields. */
export const nonReleaseSupplementSchema = z.object({
  productId:z.string().min(1).max(200),itemKey:z.string().regex(/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/),
  expectedRevision:z.number().int().positive(),developmentEventId:z.string().uuid(),roundKey:z.string().uuid(),
  completion:z.object({kind:z.literal("local_change"),evidence:localChangeEvidenceSchema}).strict(),
  requiredArtifacts:z.array(z.never()).length(0),noReleaseReason:text,idempotencyKey:z.string().min(1).max(200),
}).strict();
export type NonReleaseSupplement = z.infer<typeof nonReleaseSupplementSchema> & {
  attribution:{accountId:string;clientId:string};
};
