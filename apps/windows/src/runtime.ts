import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { privateDir } from "../../node/src/storage.js";

/** Hosts run an immutable copy outside the installation directory, so an app
 * update never replaces the executable or source of a running conversation.
 */
export function prepareRuntime(source: string, state: string): { node: string; worker: string } {
  const manifest = JSON.parse(readFileSync(join(source, "runtime.json"), "utf8")) as { files: Record<string, string> };
  if (!manifest.files || Object.keys(manifest.files).length !== 2 || !manifest.files["worker.mjs"]
    || !manifest.files[process.platform === "win32" ? "node.exe" : "node"]) throw new Error("客户端运行时清单无效");
  const id = createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex");
  const root = join(state, "runtimes", id); privateDir(root);
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (!["node", "node.exe", "worker.mjs"].includes(name) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("客户端运行时文件无效");
    const sourceFile = join(source, name); const target = join(root, name);
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    if (hash(sourceFile) !== digest) throw new Error("客户端运行时校验失败，请重新安装可信安装包");
    if (!existsSync(target)) copyFileSync(sourceFile, target);
    if (hash(target) !== digest) throw new Error("本地运行时已变化，不能覆盖现有会话使用的文件");
  }
  return { node: join(root, process.platform === "win32" ? "node.exe" : "node"), worker: join(root, "worker.mjs") };
}
