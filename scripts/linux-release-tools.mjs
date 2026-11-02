// Linux publication hooks shared by the repository and installed release tools.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
export const LINUX_STEM = "missiongo-linux-latest";
export function checkLinuxFiles(root, record) {
  const directory = join(root, "apps/web/public/downloads");
  const path = join(directory, `${LINUX_STEM}.tgz`);
  const manifest = JSON.parse(readFileSync(join(directory, `${LINUX_STEM}.json`), "utf8"));
  const metadata = Object.fromEntries(readFileSync(join(directory, `${LINUX_STEM}.release`), "utf8").split("\n").filter(Boolean).map((line) => {
    const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)];
  }));
  if (!SHA.test(record.commit ?? "") || !DIGEST.test(record.sha256 ?? "") || manifest.version !== record.version
    || manifest.sourceCommit !== record.commit || metadata.source_commit !== record.commit || metadata.source_dirty !== "false"
    || metadata.version !== record.version || metadata.sha256 !== record.sha256 || manifest.sha256 !== record.sha256
    || digest(path) !== record.sha256 || statSync(path).size !== manifest.size) throw new Error("Linux package, manifest, provenance and release ledger must agree");
  execFileSync("git", ["merge-base", "--is-ancestor", record.commit, "HEAD"], { cwd: root });
  return { version: record.version, sourceCommit: record.commit, sha256: record.sha256 };
}
export function checkLinuxArtifacts(root, live) {
  const record = JSON.parse(readFileSync(join(root, "released.json"), "utf8")).artifacts.linuxCli;
  if (!record || (record.version === null && record.commit === null)) return;
  if (existsSync(join(root, "apps/web/public/downloads", `${LINUX_STEM}.tgz`))) return checkLinuxFiles(root, record);
  if (!live || live.version !== record.version || live.sourceCommit !== record.commit || live.sha256 !== record.sha256) throw new Error("No matching local or current live Linux package; refusing deployment");
  return live;
}
export function readLinuxSnapshot({ host, currentLink }) {
  if (!host || !currentLink?.startsWith("/")) return null;
  const directory = `${currentLink}/apps/web/public/downloads`;
  const command = `if [ -s ${quote(`${directory}/${LINUX_STEM}.tgz`)} ]; then cat ${quote(`${directory}/${LINUX_STEM}.json`)} && printf '\\n' && sha256sum ${quote(`${directory}/${LINUX_STEM}.tgz`)}; fi`;
  const text = execFileSync("ssh", [host, command], { encoding: "utf8", timeout: 20_000 }).trim();
  if (!text) return null;
  const end = text.lastIndexOf("\n"); const manifest = JSON.parse(text.slice(0, end));
  if (!SHA.test(manifest.sourceCommit ?? "") || !DIGEST.test(manifest.sha256 ?? "") || !text.slice(end + 1).startsWith(manifest.sha256 + " ")) return null;
  return { version: manifest.version, sourceCommit: manifest.sourceCommit, sha256: manifest.sha256 };
}
export async function verifyLinuxPublic(origin, release) {
  if (!release) return false;
  const response = await fetch(new URL(`/downloads/${LINUX_STEM}.json`, origin), { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return false;
  const manifest = await response.json();
  if (manifest.version !== release.version || manifest.sourceCommit !== release.sourceCommit || manifest.sha256 !== release.sha256) return false;
  const binary = await fetch(new URL(`/downloads/${LINUX_STEM}.tgz`, origin), { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!binary.ok || !binary.body) return false;
  const hash = createHash("sha256"); let size = 0;
  for await (const chunk of binary.body) { size += chunk.length; hash.update(chunk); }
  return hash.digest("hex") === release.sha256 && size === manifest.size;
}
