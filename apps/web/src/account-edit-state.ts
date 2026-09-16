export type AccountEditor = "nickname" | "email" | "password" | "new-account" | `account:${string}`;

/**
 * Account settings are read-only until one explicit editor is chosen. While an
 * editor is open, a second intent cannot replace it and silently discard work.
 */
export function openAccountEditor(current: AccountEditor | null, requested: AccountEditor): AccountEditor {
  return current ?? requested;
}

/** Only the editor that is currently open can return the panel to view mode. */
export function closeAccountEditor(current: AccountEditor | null, requested: AccountEditor): AccountEditor | null {
  return current === requested ? null : current;
}
