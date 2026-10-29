import type { AgentArtifactBundle, AgentArtifactFile } from "@missiongo/domain";

export const ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const artifactText = (file: AgentArtifactFile) => new TextDecoder().decode(Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0)));
export const artifactDataUrl = (file: AgentArtifactFile) => `data:${file.contentType};base64,${file.base64}`;
const encode = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
};

/** Embed only the saved bundle. Relative dependencies cannot reach the application or a network origin. */
export function artifactHtml(bundle: AgentArtifactBundle): string {
  const files = new Map(bundle.files.map((file) => [file.name, file]));
  const cache = new Map<string, string>();
  const resolving = new Set<string>();
  const resource = (reference: string, from: string): string => {
    if (reference.startsWith("#") || reference.startsWith("data:")) return reference;
    let url: URL;
    try { url = new URL(reference, `https://artifact.invalid/${from}`); } catch { return "about:blank"; }
    if (url.origin !== "https://artifact.invalid") return "about:blank";
    const name = decodeURIComponent(url.pathname.slice(1));
    const file = files.get(name);
    if (!file || resolving.has(name)) return "about:blank";
    if (cache.has(name)) return cache.get(name)! + url.hash;
    resolving.add(name);
    let text: string | undefined;
    if (file.contentType === "text/html") text = html(artifactText(file), name);
    if (file.contentType === "text/css") text = css(artifactText(file), name);
    if (file.contentType === "text/javascript") text = script(artifactText(file), name);
    const result = text === undefined ? artifactDataUrl(file) : `data:${file.contentType};base64,${encode(text)}`;
    resolving.delete(name); cache.set(name, result);
    return result + url.hash;
  };
  const css = (text: string, name: string) => text
    .replace(/url\(\s*["']?([^\s)'";]+)["']?\s*\)/gi, (_, ref: string) => `url("${resource(ref, name)}")`)
    .replace(/(@import\s+)["']([^"']+)["']/gi, (_, prefix: string, ref: string) => `${prefix}"${resource(ref, name)}"`);
  const script = (text: string, name: string) => text.replace(/(\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']+)["']/g,
    (_, prefix: string, ref: string) => `${prefix}"${resource(ref, name)}"`);
  const html = (text: string, name: string): string => {
    const document = new DOMParser().parseFromString(text, "text/html");
    document.querySelectorAll("base,meta,iframe,object,embed").forEach((element) => element.remove());
    document.querySelectorAll("*").forEach((element) => {
      for (const attr of ["src", "href", "poster", "xlink:href"]) {
        if (element.hasAttribute(attr)) element.setAttribute(attr, resource(element.getAttribute(attr)!, name));
      }
      element.removeAttribute("srcset");
      element.removeAttribute("ping");
      element.removeAttribute("formaction");
      element.removeAttribute("target");
      if (element.hasAttribute("style")) element.setAttribute("style", css(element.getAttribute("style")!, name));
    });
    document.querySelectorAll("style").forEach((element) => { element.textContent = css(element.textContent ?? "", name); });
    document.querySelectorAll("script:not([src])").forEach((element) => { element.textContent = script(element.textContent ?? "", name); });
    const policy = document.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy"; policy.content = ARTIFACT_CSP;
    document.head.prepend(policy);
    return "<!doctype html>" + document.documentElement.outerHTML;
  };
  const entry = files.get(bundle.entry);
  return entry ? html(artifactText(entry), bundle.entry) : "";
}
