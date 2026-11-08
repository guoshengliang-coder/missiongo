/** Checks are execution evidence, never human acceptance. */
export interface DeliveryValidation {
  readonly checks: readonly { readonly name: string; readonly method: string; readonly result: "passed" | "failed" | "not_run"; readonly evidence: string }[];
  readonly remainingVerification: readonly string[];
  readonly limitations: readonly string[];
}
export interface LocalChangeEvidence {
  readonly version: 1;
  readonly target: string;
  readonly summary: string;
  readonly files: readonly { readonly name: string; readonly beforeSha256: string | null; readonly afterSha256: string | null; readonly sizeBytes: number }[];
  readonly rollback: string;
  readonly validation: DeliveryValidation;
}
/** Applied local changes do not fabricate Git integration or publication. */
export type CompletionReference =
  | { readonly kind: "github" | "gitlab"; readonly url: string }
  | { readonly kind: "commit"; readonly commit: string; readonly targetBranch: string }
  | { readonly kind: "manual"; readonly commit: string; readonly description: string }
  | { readonly kind: "local_change"; readonly evidence: LocalChangeEvidence };
