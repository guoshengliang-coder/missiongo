import { MAX_ITEM_ATTACHMENTS } from "@missiongo/domain";

import { validateAttachment } from "./attachment-validation";
import type { useI18n } from "./i18n";

export function validateIncomingFiles(
  current: readonly File[],
  incoming: readonly File[],
  t: ReturnType<typeof useI18n>["t"],
  totalLimit = MAX_ITEM_ATTACHMENTS,
): { files: readonly File[]; error?: string } {
  const remaining = totalLimit - current.length;
  if (incoming.length > remaining) return { files: current, error: t("tooManyFiles", { count: remaining }) };
  const known = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  const accepted: File[] = [];
  let error: string | undefined;
  for (const file of incoming) {
    const validation = validateAttachment(file);
    if (!validation.valid && validation.reason === "unsupported") {
      error ??= t("unsupportedFile", { filename: file.name });
      continue;
    }
    if (!validation.valid && validation.reason === "too-large") {
      error ??= t("fileTooLarge", { filename: file.name, size: validation.limitMiB });
      continue;
    }
    const identity = `${file.name}:${file.size}:${file.lastModified}`;
    if (!known.has(identity)) {
      known.add(identity);
      accepted.push(file);
    }
  }
  return { files: [...current, ...accepted], ...(error ? { error } : {}) };
}
