/** Integration identity; publication and human acceptance are separate facts. */
export type CompletionReference =
  | { readonly kind: "github" | "gitlab"; readonly url: string }
  | { readonly kind: "commit"; readonly commit: string; readonly targetBranch: string }
  | { readonly kind: "manual"; readonly commit: string; readonly description: string };
