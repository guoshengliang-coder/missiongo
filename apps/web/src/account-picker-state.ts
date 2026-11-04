/**
 * What the product-access picker says about one candidate (AND-390).
 *
 * Split out of the component so the three outcomes are testable without a DOM:
 * a candidate can be chosen, is already on the product, or is already queued
 * for the next save. Only the first is selectable.
 */
export type AccountPickerState = "selectable" | "granted" | "queued";

export function accountPickerState(
  account: { readonly id: string; readonly email: string },
  grantedAccountIds: ReadonlySet<string>,
  queuedEmails: ReadonlySet<string>,
): AccountPickerState {
  if (queuedEmails.has(account.email.toLocaleLowerCase())) return "queued";
  return grantedAccountIds.has(account.id) ? "granted" : "selectable";
}

/**
 * The next row the arrow keys may land on, skipping the ones that cannot be
 * chosen. Returns `from` when there is none, so the highlight stays put rather
 * than jumping to a disabled row.
 */
export function nextEnabledIndex(
  count: number,
  from: number,
  step: 1 | -1,
  enabled: (index: number) => boolean,
): number {
  // Nothing is highlighted yet. Down starts at the top; up starts at the bottom,
  // which is what every command palette does and what the user expects.
  const start = from < 0 ? (step === 1 ? -1 : count) : from;
  for (let index = start + step; index >= 0 && index < count; index += step) {
    if (enabled(index)) return index;
  }
  return from;
}
