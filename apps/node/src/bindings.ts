import { createHash } from "node:crypto";
import { join } from "node:path";
import { readPrivate, savePrivate } from "./storage.js";
import type { Kind } from "./types.js";

export interface LocalBinding { kind: Kind; sessionRef: string; dispatchId: string; nodeId?: string; external?: boolean; managed?: boolean }
export function nativeKey(kind: string, ref: string): string { return createHash("sha256").update(kind).update("\0").update(ref).digest("hex"); }
export function saveBinding(root: string, binding: LocalBinding): void { savePrivate(join(root, "native-bindings", `${nativeKey(binding.kind, binding.sessionRef)}.json`), binding); }
export function findBinding(root: string, kind: Kind, ref: string, nodeId?: string): LocalBinding | undefined {
  const value = readPrivate<LocalBinding>(join(root, "native-bindings", `${nativeKey(kind, ref)}.json`));
  return value?.kind === kind && value.sessionRef === ref && value.nodeId === nodeId && !value.managed ? value : undefined;
}
