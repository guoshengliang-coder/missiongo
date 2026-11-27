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

/** Stable HTTPS spelling for project repository identity, never retaining credentials. */
export function projectRepositoryIdentity(raw: string): string | undefined {
  const value = raw.trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\/$/, "")
    .replace(/\.git$/i, "");
  const remote = value.match(/^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\/([a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+)$/i);
  if (!remote || remote[2]!.split("/").some(part => part === "." || part === "..")) return;
  const host = remote[1]!.toLowerCase();
  const path = host === "github.com" ? remote[2]!.toLowerCase() : remote[2]!;
  return `https://${host}/${path}`;
}
