export const FILE_LIMITS_MIB: Readonly<Record<string, number>> = {
  png: 20,
  jpg: 20,
  jpeg: 20,
  webp: 20,
  gif: 20,
  heic: 20,
  mp4: 100,
  mov: 100,
  webm: 100,
  log: 10,
  txt: 10,
  md: 10,
  csv: 10,
  json: 10,
  pdf: 20,
};

export type AttachmentValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: "unsupported" }
  | { readonly valid: false; readonly reason: "too-large"; readonly limitMiB: number };

export function validateAttachment(
  file: Pick<File, "name" | "size">,
  allowedExtensions?: readonly string[],
): AttachmentValidation {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const limitMiB = FILE_LIMITS_MIB[extension];
  if (!limitMiB || (allowedExtensions && !allowedExtensions.includes(extension))) {
    return { valid: false, reason: "unsupported" };
  }
  if (file.size > limitMiB * 1024 * 1024) {
    return { valid: false, reason: "too-large", limitMiB };
  }
  return { valid: true };
}
