/** Recognize local artifact destinations without treating ordinary site routes as files. */
export function localArtifactPath(href: string): string | undefined {
  let path = href.replace(/^(?:sandbox:|file:\/\/(?:localhost)?)/i, "").split(/[?#]/, 1)[0]!;
  try { path = decodeURIComponent(path); } catch { return undefined; }
  if (!/^\/(?:Users|private|tmp|var\/folders|Volumes|home|mnt)\//.test(path)
    || [...path].some((char) => char.charCodeAt(0) < 32) || path.includes("\\") || path.split("/").includes("..")) return undefined;
  return path;
}

/** Match only explicit Markdown links/images, including angle-delimited paths. */
export function localArtifactLinks(text: string): string[] {
  const links: string[] = [];
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)) {
    const href = match[1] ?? match[2]!;
    if (localArtifactPath(href)) links.push(href);
  }
  return [...new Set(links)];
}

export interface AgentArtifactFile { name: string; contentType: string; base64: string }
export interface AgentArtifactBundle { entry: string; files: AgentArtifactFile[] }
export interface AgentArtifactState {
  id: string; status: "pending" | "ready" | "failed"; error?: string; filename: string;
}
