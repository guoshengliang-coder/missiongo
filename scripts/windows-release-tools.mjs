import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { publicDownloadHash } from "./public-download.mjs";
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export const WINDOWS_PATH = "apps/web/public/downloads/windows";
export function assertWindowsReleasePolicy(manifest, product, pin) {
  if (manifest.signed) {
    if (!DIGEST.test(pin ?? "") || manifest.certificateSha256 !== pin) throw new Error("Select the trusted Windows certificate SHA-256");
  } else if (product.releaseSigning !== "temporary-unsigned") throw new Error("Unsigned publication is not authorized by the current product policy");
}
export function windowsManifest(value) {
  const signatureValid = value?.signed === true ? DIGEST.test(value.certificateSha256 ?? "")
    : value?.signed === false && value.releaseSigning === "temporary-unsigned" && value.certificateSha256 === null;
  if (!value || !VERSION.test(value.version ?? "") || !SHA.test(value.sourceCommit ?? "") || !DIGEST.test(value.sha256 ?? "")
    || !signatureValid || value.platform !== "win32" || value.arch !== "x64"
    || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > 512 * 1024 * 1024
    || !/^[a-z0-9-]+-[0-9]+\.[0-9]+\.[0-9]+-x64-setup\.exe$/.test(value.filename ?? "")) throw new Error("Windows package needs explicit signing provenance and an immutable x64 installer filename");
  if (value.releaseNotes !== undefined && (!Array.isArray(value.releaseNotes) || value.releaseNotes.length > 100
    || value.releaseNotes.some(note => !note || !Array.isArray(note.items) || note.items.length > 100
      || note.items.some(item => !item || typeof item.title !== "string" || item.title.length > 1000)))) throw new Error("Invalid Windows release notes");
  if (!value.filename.includes(`-${value.version}-x64-setup.exe`)) throw new Error("Windows installer filename version differs from manifest");
  return value;
}
export function checkWindowsFiles(root, record) {
  const directory = join(root, WINDOWS_PATH);
  const manifest = windowsManifest(JSON.parse(readFileSync(join(directory, "latest.json"), "utf8")));
  const installer = join(directory, manifest.filename); const stat = lstatSync(installer);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.size || manifest.version !== record.version || manifest.sourceCommit !== record.commit || manifest.sha256 !== record.sha256) throw new Error("Windows installer, manifest and ledger disagree");
  const bytes = readFileSync(installer);
  if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) throw new Error("Windows installer changed");
  const update = readFileSync(join(directory, "latest.yml"), "utf8");
  if (update !== windowsUpdate(manifest, bytes)) throw new Error("Windows updater metadata differs from the installer");
  execFileSync("git", ["merge-base", "--is-ancestor", record.commit, "HEAD"], { cwd: root, stdio: "pipe" });
  return { version: record.version, sourceCommit: record.commit, sha256: record.sha256, filename: manifest.filename };
}
export function windowsUpdate(manifest, bytes) {
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const notes = manifest.releaseNotes?.flatMap(note=>note.items.map(item=>item.title)).join("\n");
  return `version: ${manifest.version}\nfiles:\n  - url: ${manifest.filename}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${manifest.filename}\nsha512: ${sha512}\n${notes ? `releaseNotes: ${JSON.stringify(notes)}\n` : ""}`;
}
export function checkWindowsArtifacts(root, live) {
  const record = JSON.parse(readFileSync(join(root, "released.json"), "utf8")).artifacts.windowsApp;
  if (!record || record.version === null && record.commit === null) {
    if (live || existsSync(join(root, WINDOWS_PATH, "latest.json"))) throw new Error("Unrecorded Windows publication would bypass release coverage");
    return;
  }
  if (existsSync(join(root, WINDOWS_PATH, "latest.json"))) return checkWindowsFiles(root, record);
  if (!live || live.version !== record.version || live.sourceCommit !== record.commit || live.sha256 !== record.sha256) throw new Error("No matching local or verified live Windows package");
  return live;
}
export function readWindowsSnapshot({ host, currentLink }, readRemote) {
  if (!host || !currentLink?.startsWith("/")) return null;
  const directory = `${currentLink}/${WINDOWS_PATH}`;
  const run = readRemote ?? (command => execFileSync("ssh", [host, command], { encoding: "utf8", timeout: 20_000 }).trim());
  const text = run(`if [ -s ${quote(`${directory}/latest.json`)} ]; then cat ${quote(`${directory}/latest.json`)}; fi`);
  if (!text) return null;
  // An existing but unverifiable package must block inheritance, not disappear as unpublished.
  const manifest = windowsManifest(JSON.parse(text));
  const sha = run(`sha256sum ${quote(`${directory}/${manifest.filename}`)}`);
  if (!sha.startsWith(manifest.sha256 + " ")) throw new Error("Live Windows installer digest differs from manifest");
  return { version: manifest.version, sourceCommit: manifest.sourceCommit, sha256: manifest.sha256, filename: manifest.filename };
}
export async function verifyWindowsPublic(origin, release) {
  if (!release) return false;
  const response = await fetch(new URL("/downloads/windows/latest.json", origin), { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return false;
  const manifest = windowsManifest(await response.json());
  if (manifest.version !== release.version || manifest.sourceCommit !== release.sourceCommit || manifest.sha256 !== release.sha256 || manifest.filename !== release.filename) return false;
  const result=await publicDownloadHash(new URL(`/downloads/windows/${manifest.filename}`,origin),{maxBytes:manifest.size});
  return result.bytes===manifest.size&&result.sha256===manifest.sha256;
}
