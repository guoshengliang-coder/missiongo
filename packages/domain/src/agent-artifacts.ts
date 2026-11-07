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

/** Only explicit local image references are fetched automatically; documents stay opt-in. */
export function localArtifactImageLinks(text: string): string[] {
  const paths = new Set<string>();
  return localArtifactLinks(text).filter((href) => {
    const path = localArtifactPath(href)!;
    if (!/\.(?:png|jpe?g|gif|webp|svg)$/i.test(path) || paths.has(path)) return false;
    paths.add(path);
    return true;
  });
}

export interface AgentArtifactFile { name: string; contentType: string; base64: string }
export interface AgentArtifactBundle { entry: string; files: AgentArtifactFile[]; skippedResources?: string[] }
export interface AgentArtifactState {
  id: string; status: "pending" | "ready" | "failed"; error?: string; errorResource?: string; filename: string;
}

/** Safe diagnostic names, never native absolute paths or control characters. */
export function artifactResourceName(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !/[\\?#]/.test(value) && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    && value.split("/").every(part => Boolean(part) && !part.startsWith("."));
}

export const ARTIFACT_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null) as Record<string, string>, {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  html: "text/html", htm: "text/html", md: "text/markdown", txt: "text/plain", log: "text/plain", csv: "text/csv",
  json: "application/json", pdf: "application/pdf", css: "text/css", js: "text/javascript", mjs: "text/javascript",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
}));

export interface ArtifactReference { reference: string; download: boolean }
const captures = (pattern: RegExp, text: string): string[] => [...text.matchAll(pattern)].map(match => match.slice(1).find(value => value !== undefined)!).filter(Boolean);
const cssReferences = (text: string) => {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...captures(/\burl\(\s*["']?([^\s)'";]+)/gi, css), ...captures(/@import\s+["']([^"']+)["']/gi, css)];
};
const moduleReferences = (text: string) => captures(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']+)["']/g, text);

/** Static references only: never execute scripts or mistake URL APIs for CSS. */
export function artifactReferences(text: string, type: string): ArtifactReference[] {
  const required = (reference: string): ArtifactReference => ({ reference, download: false });
  if (type === "text/css") return cssReferences(text).map(required);
  if (type === "text/javascript") return moduleReferences(text).map(required);
  if (type === "text/markdown") return [...text.matchAll(/(!?)\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)]
    .map(match => ({ reference: match[3] ?? match[2]!, download: !match[1] }));
  if (type !== "text/html") return [];
  const html = text.replace(/<!--[\s\S]*?-->/g, "");
  const scripts = captures(/<script\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script\s*>/gi, html);
  const styles = captures(/<style\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/style\s*>/gi, html);
  const markup = html.replace(/(<(?:script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>)[\s\S]*?(<\/(?:script|style)\s*>)/gi, "$1$2");
  const result = [...styles.flatMap(cssReferences), ...scripts.flatMap(moduleReferences)].map(required);
  for (const tag of captures(/(<(?:[^<>"']|"[^"]*"|'[^']*')+>)/g, markup)) {
    for (const match of tag.matchAll(/\s(src|href|poster|style)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
      const reference = match[2] ?? match[3] ?? match[4]!;
      if (match[1]!.toLowerCase() === "style") result.push(...cssReferences(reference).map(required));
      else result.push({ reference, download: /^<a\b/i.test(tag) && match[1]!.toLowerCase() === "href" });
    }
  }
  return result;
}

export function artifactRelativeResource(reference: string, from: string): string | undefined {
  if (!reference || reference.startsWith("#") || reference.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(reference)) return undefined;
  const decoded = decodeURIComponent(reference.split(/[?#]/, 1)[0]!);
  if (decoded.startsWith("/") || decoded.includes("\\") || [...decoded].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error("file_denied");
  const parts = from.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) throw new Error("file_denied"); parts.pop(); }
    else { if (part.startsWith(".")) throw new Error("file_denied"); parts.push(part); }
  }
  const name = parts.join("/");
  if (!artifactResourceName(name)) throw new Error("file_denied");
  return name;
}
