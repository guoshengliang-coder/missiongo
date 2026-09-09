/**
 * Telling a dead code-split chunk apart from an ordinary render error.
 *
 * Every build renames every chunk: `MISSIONGO_BUILD_STAMP` puts a fresh value in
 * the entry chunk, the lazily-loaded chunks import the entry chunk by filename,
 * so their own content hashes move with it. nginx answers `=404` for a hashed
 * asset it no longer has. A page still running an older build therefore asks for
 * a file that does not exist the moment someone opens a lazily-loaded screen --
 * which is what AND-35 was: the annotator's chunk was gone, `lazy()` rejected,
 * and with no boundary above it React unmounted the whole tree into a blank page.
 *
 * Nothing inside the running page can fix this. The name it holds is the name
 * that is gone, so retrying the import fetches the same missing file. Only a new
 * document carries the new names, which is why the offer is a reload rather than
 * a retry.
 */

/**
 * What each engine says when a dynamic import cannot be fetched or parsed, plus
 * the message Vite's own preload helper throws for a stylesheet it could not
 * bring in. Matched as substrings against a lowercased message because the rest
 * of the text is the URL, which differs on every build.
 */
const CHUNK_LOAD_MESSAGES = [
  "failed to fetch dynamically imported module", // Chromium
  "error loading dynamically imported module", // Firefox
  "importing a module script failed", // Safari
  "unable to preload css", // Vite's __vitePreload
];

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const normalized = message.toLowerCase();
  return CHUNK_LOAD_MESSAGES.some((phrase) => normalized.includes(phrase));
}
