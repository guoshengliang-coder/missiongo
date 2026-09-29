/**
 * Enter in a reply composer: send on a keyboard, newline on a touch screen (AND-256).
 *
 * Pure on purpose. The rule has more branches than it looks, and each one is
 * worth testing without a DOM; the agent console and the inline session panel
 * both use it, so an inline copy in each would be two rules to keep in step.
 */

/** Touch behaviour hangs off the same query the touch sizing does (see styles.css). */
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

export type ComposerEnterEvent = {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  /** True while an input method is composing; Enter picks a candidate then. */
  readonly composing: boolean;
};

export type ComposerEnterAction = {
  /** Submit the surrounding form. */
  readonly submit: boolean;
  /** Keep the browser from inserting the newline the key would otherwise add. */
  readonly preventDefault: boolean;
};

/** Leave the key to the browser. */
const IGNORE: ComposerEnterAction = { submit: false, preventDefault: false };

export function composerEnterAction(event: ComposerEnterEvent, text: string, touch: boolean): ComposerEnterAction {
  if (event.key !== "Enter") return IGNORE;
  // Enter confirming an IME candidate must not post half a word.
  if (event.composing) return IGNORE;
  // Shift is the newline escape hatch on a keyboard; the other modifiers stay with the browser.
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return IGNORE;
  // An empty box sends nothing either way, and swallowing the key keeps a stray
  // leading blank line out of the reply.
  if (text.trim() === "") return { submit: false, preventDefault: true };
  // A soft keyboard has no Shift, so Enter is the only way to break a line there.
  // Sending on a phone is the button's job.
  if (touch) return IGNORE;
  return { submit: true, preventDefault: true };
}

export function isCoarsePointer(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(COARSE_POINTER_QUERY).matches;
}
