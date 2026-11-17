import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixedCommand, type FixedCommand } from "./fixed-command.js";
import type { API } from "./api.js";
import { readPrivate, savePrivate } from "./storage.js";
import type { RepoMapping } from "./types.js";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function repositoryIdentity(raw: string): { host: string; path: string; origin: string } | undefined {
  const remote = raw.trim(); let host: string; let path: string;
  try {
    if (remote.startsWith("git@")) { const colon = remote.indexOf(":"); if (colon < 0) return undefined; host = remote.slice(4, colon); path = remote.slice(colon + 1); }
    else { const url = new URL(remote); if (!["https:", "ssh:"].includes(url.protocol) || url.username && url.username !== "git" || url.password || url.search || url.hash) return undefined; host = url.protocol === "ssh:" ? url.hostname : url.host; path = url.pathname.replace(/^\//, ""); }
    path = path.replace(/\.git$/, ""); host = host.toLowerCase();
    if (!/^[a-z0-9.-]+(?::[0-9]+)?$/.test(host) || !/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+$/i.test(path) || path.split("/").some((part) => part === "." || part === "..")) return undefined;
    return { host, path, origin: `https://${host}/${path}` };
  } catch { return undefined; }
}
/** Uploads release facts only. Never claims checks or changes item state. */
export class ReleaseObservations {
  private root: string;
  constructor(root: string, private api: Pick<API, "server" | "token" | "call">, private run: FixedCommand = fixedCommand) {
    this.root = join(root, "delivery", createHash("sha256").update(api.server).update("\0").update(api.token ?? "").digest("hex"));
  }
  async uploadObservations(repos: RepoMapping[]): Promise<void> {
    let attempted = 0;
    for (const mapping of repos) {
      const common = await this.run("git", ["rev-parse", "--git-common-dir"], mapping.repoPath);
      const remote = await this.run("git", ["config", "--get", "remote.origin.url"], mapping.repoPath);
      const identity = repositoryIdentity(remote.stdout);
      if (common.code || !common.stdout || remote.code || !identity) continue;
      const outbox = join(resolve(mapping.repoPath, common.stdout), "missiongo-release-outbox");
      if (!existsSync(outbox)) continue;
      for (const name of readdirSync(outbox).filter((name) => /^[a-z0-9_-]+\.json$/i.test(name)).sort()) {
        const path = join(outbox, name); const key = createHash("sha256").update(mapping.productId).update(path).digest("hex");
        const journal = join(this.root, "release-delivery", `${key}.json`);
        const delivered = readPrivate<{ delivered?: boolean; attempts?: number; nextAttempt?: number }>(journal) ?? {};
        if (delivered.delivered || (delivered.nextAttempt ?? 0) > Date.now()) continue;
        if (attempted++ >= 20) return;
        try {
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Invalid release file");
          const observation = JSON.parse(readFileSync(path, "utf8"));
          if (observation.schemaVersion !== 2 || !UUID.test(observation.id) || observation.repository !== identity.origin
            || !Array.isArray(observation.releases) || observation.releases.length > 20) throw new Error("Release observation binding differs");
          const receipt = await this.api.call("POST", "/api/v1/node/release-observations", { productId: mapping.productId, repoPath: mapping.repoPath, observation });
          if (!receipt.accepted || receipt.id !== observation.id) throw new Error("Release observation receipt differs");
          savePrivate(journal, { delivered: true });
        } catch {
          const attempts = Math.min((delivered.attempts ?? 0) + 1, 10);
          savePrivate(journal, { attempts, nextAttempt: Date.now() + Math.min(30_000 * 2 ** (attempts - 1), 1_800_000) });
        }
      }
    }
  }
}
