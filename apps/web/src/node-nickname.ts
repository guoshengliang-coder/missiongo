import type { DispatchNode } from "./types";

/**
 * The server's limit. It becomes the prefix of every session name this machine
 * starts, where a long one pushes the item keys out of sight. Counted the way
 * the server counts (`String.length`), so the console never passes a nickname
 * the server then refuses, nor refuses one it would take.
 */
export const MAX_NODE_NICKNAME_LENGTH = 40;

export type NicknameDraft =
  | { readonly ok: true; readonly nickname: string | null }
  | { readonly ok: false; readonly reason: "tooLong" };

/**
 * What saving the field would send. Blank means "no nickname" rather than an
 * empty one, because an empty prefix would name sessions `-AND-37`; the server
 * treats it the same way, so null is the honest payload.
 */
export function parseNicknameDraft(draft: string): NicknameDraft {
  const nickname = draft.trim();
  if (!nickname) return { ok: true, nickname: null };
  if (nickname.length > MAX_NODE_NICKNAME_LENGTH) return { ok: false, reason: "tooLong" };
  return { ok: true, nickname };
}

/**
 * Whether save has anything to do. Compared after trimming, so a stray space
 * does not offer a save that would change nothing -- and an unset nickname and a
 * blank field are the same thing.
 */
export function nicknameDraftChanged(draft: string, node: Pick<DispatchNode, "nickname">): boolean {
  const parsed = parseNicknameDraft(draft);
  return !parsed.ok || parsed.nickname !== (node.nickname ?? null);
}

/**
 * What the machine would be called if the field were saved as it stands, so
 * the example session name follows the typing. An over-long draft cannot be
 * saved, so the example stays on the name the machine really has.
 */
export function draftDisplayName(draft: string, node: Pick<DispatchNode, "deviceName" | "nickname">): string {
  const parsed = parseNicknameDraft(draft);
  if (!parsed.ok) return node.nickname ?? node.deviceName;
  return parsed.nickname ?? node.deviceName;
}
