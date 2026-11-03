import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { localArtifactLinks, localArtifactPath, type AgentArtifactBundle } from "@missiongo/domain";
import type { Message, HostState } from "./types.js";
import { directories, readPrivate } from "./storage.js";
import { hostDirectory } from "./host.js";
import type { API } from "./api.js";

interface ArtifactJob { id: string; sessionRef: string; agentKind: string; sourceId: string; href: string }
const imageTypes: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };
class ArtifactError extends Error {}

/** Only the exact image explicitly emitted by this native conversation is eligible. */
export async function readImageArtifact(job: Pick<ArtifactJob, "sourceId" | "href">, messages: readonly Message[]): Promise<AgentArtifactBundle> {
  const message = messages.find((entry) => entry.sourceId === job.sourceId && ["agent", "plan"].includes(entry.role));
  const path = localArtifactPath(job.href);
  if (!path || !message || !localArtifactLinks(message.text).includes(job.href)) throw new ArtifactError("reference_missing");
  const contentType = imageTypes[extname(path).toLowerCase()];
  if (!contentType) throw new ArtifactError("unsupported");
  const name = basename(path);
  if (name.startsWith(".")) throw new ArtifactError("file_denied");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    throw new ArtifactError(error.code === "ENOENT" ? "file_missing" : "file_denied");
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ArtifactError("file_denied");
    if (stat.size <= 0 || stat.size > 20 * 1024 * 1024) throw new ArtifactError("too_large");
    // Bound the read as well as the initial stat: the file may grow concurrently.
    const parts: Buffer[] = []; let total = 0;
    for (;;) {
      const part = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(part, 0, part.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > 20 * 1024 * 1024) throw new ArtifactError("too_large");
      parts.push(part.subarray(0, bytesRead));
    }
    return { entry: name, files: [{ name, contentType, base64: Buffer.concat(parts).toString("base64") }] };
  } finally { await handle.close(); }
}

/** Reads the node's own private dispatch journal; never starts/resumes a source session. */
export async function completeImageArtifacts(root: string, api: Pick<API, "call">): Promise<void> {
  const { jobs } = await api.call("GET", "/api/v1/node/agent-artifacts") as { jobs: ArtifactJob[] };
  for (const job of jobs) {
    let result: { bundle: AgentArtifactBundle } | { error: string };
    try {
      const state = directories(join(root, "sessions")).map((key) => readPrivate<HostState>(join(hostDirectory(root, key), "state.json")))
        .find((entry) => entry?.phase === "launched" && entry.sessionRef === job.sessionRef && entry.dispatch.agentKind === job.agentKind);
      if (!state) throw new ArtifactError("node_unavailable");
      result = { bundle: await readImageArtifact(job, state.snapshot.messages) };
    } catch (error) { result = { error: error instanceof ArtifactError ? error.message : "node_unavailable" }; }
    await api.call("POST", `/api/v1/node/agent-artifacts/${encodeURIComponent(job.id)}`, result);
  }
}
