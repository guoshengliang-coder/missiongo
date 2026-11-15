/** Shape validation only: the selected node must verify the actual checkout. */
export function isAbsoluteRepositoryPath(path: string): boolean {
  if (!path || [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return false;
  // Never accept drive-relative paths, device namespaces or a Windows root
  // relative to the process's current drive. UNC shares must name a server/share.
  if (/^\\\\[?.]\\/.test(path) || /^\/\/[?.]\//.test(path)) return false;
  if (/^[a-z]:[\\/]/i.test(path)) return !path.slice(2).includes(":");
  if (path.startsWith("\\\\")) return /^\\\\[^\\/:]+\\[^\\/:]+(?:\\[^:]*)?$/.test(path);
  return path.startsWith("/") && !path.includes("\\");
}
