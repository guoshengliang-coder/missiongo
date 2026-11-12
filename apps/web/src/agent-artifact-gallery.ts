import { localArtifactLinks, localArtifactPath } from "@missiongo/domain";

/** Only explicit image/HTML references in this one message; resources are not slides. */
export function artifactGalleryLinks(text: string): string[] {
  const seen = new Set<string>();
  return localArtifactLinks(text).filter(href => {
    const path = localArtifactPath(href)!;
    if (!/\.(?:png|jpe?g|gif|webp|svg|html?)$/i.test(path) || seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}
