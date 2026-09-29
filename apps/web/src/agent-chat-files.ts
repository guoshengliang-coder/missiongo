import { validateAttachment } from "./attachment-validation";

// Work-item handoff files do not expand the agent chat attachment surface.
const CHAT_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "heic", "mp4", "mov", "webm", "log", "txt", "json", "md", "csv", "pdf"] as const;

export type ChatFileRejection =
  | { readonly reason: "too-many" }
  | { readonly reason: "unsupported"; readonly filename: string }
  | { readonly reason: "too-large"; readonly filename: string; readonly limitMiB: number };

/**
 * Merge files picked, dropped or pasted into an agent chat reply (AND-234).
 * The whole batch is rejected on the first problem -- matching the picker
 * behaviour AND-202 shipped -- so nothing silently lands in the draft.
 */
export function mergeChatFiles(
  current: readonly File[],
  incoming: readonly File[],
  limit = 10,
): { files: File[]; rejection: ChatFileRejection | null } {
  if (incoming.length === 0) return { files: [...current], rejection: null };
  const next = [...current, ...incoming];
  if (next.length > limit) return { files: [...current], rejection: { reason: "too-many" } };
  for (const file of next) {
    const validation = validateAttachment(file, CHAT_EXTENSIONS);
    if (validation.valid) continue;
    return validation.reason === "unsupported"
      ? { files: [...current], rejection: { reason: "unsupported", filename: file.name } }
      : { files: [...current], rejection: { reason: "too-large", filename: file.name, limitMiB: validation.limitMiB } };
  }
  return { files: next, rejection: null };
}
