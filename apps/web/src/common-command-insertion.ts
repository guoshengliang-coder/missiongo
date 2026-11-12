/** Insert without deleting selected text; later edits invalidate the old undo. */
export function insertCommonCommand(value: string, content: string, position: number, limit = 20000): string | null {
  const p = Math.max(0,Math.min(value.length,position));
  const next = value.slice(0,p)+(p && !value.slice(0,p).endsWith("\n") ? "\n" : "")+content+(p<value.length ? "\n" : "")+value.slice(p);
  return next.length > limit ? null : next;
}
