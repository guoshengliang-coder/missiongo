import type { AuthenticatedUser } from "./api";

/**
 * The server's limit, counted the way the server counts it (`String.length`),
 * so the console never offers a nickname the server would then refuse, nor
 * refuses one it would have taken.
 */
export const MAX_ACCOUNT_NICKNAME_LENGTH = 40;

export type NicknameDraft =
  | { readonly ok: true; readonly nickname: string | null }
  | { readonly ok: false; readonly reason: "tooLong" };

/**
 * What saving the field would send.
 *
 * Blank means "no nickname" rather than an empty one: the server stores null
 * either way, and null is the honest thing to send. Whitespace is folded here
 * for the same reason the server folds it -- a byline is one line.
 */
export function parseNicknameDraft(draft: string): NicknameDraft {
  const nickname = draft.replaceAll(/\s+/gu, " ").trim();
  if (!nickname) return { ok: true, nickname: null };
  if (nickname.length > MAX_ACCOUNT_NICKNAME_LENGTH) return { ok: false, reason: "tooLong" };
  return { ok: true, nickname };
}

/** Whether saving would do anything. An unset nickname and a blank field are the same thing. */
export function nicknameDraftChanged(draft: string, user: Pick<AuthenticatedUser, "nickname">): boolean {
  const parsed = parseNicknameDraft(draft);
  return !parsed.ok || parsed.nickname !== (user.nickname ?? null);
}

/**
 * What the account would be signed as if the field were saved as it stands, so
 * the example under the input follows the typing.
 *
 * The real byline still comes from the server; this only previews it. An
 * over-long draft cannot be saved, so the preview stays on the current name.
 */
export function draftDisplayName(draft: string, user: Pick<AuthenticatedUser, "username" | "nickname">): string {
  const parsed = parseNicknameDraft(draft);
  const fallback = user.username.split("@")[0] || user.username;
  if (!parsed.ok) return user.nickname ?? fallback;
  return parsed.nickname ?? fallback;
}
