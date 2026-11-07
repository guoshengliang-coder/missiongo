import { constants } from "node:fs";
import { open, realpath, lstat, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { localArtifactLinks, localArtifactPath, ARTIFACT_CONTENT_TYPES, artifactResourceName, artifactReferences, artifactRelativeResource, type AgentArtifactBundle } from "@missiongo/domain";
import type { Message, HostState } from "./types.js";
import { directories, readPrivate } from "./storage.js";
import { hostDirectory } from "./host.js";
import type { API } from "./api.js";

interface ArtifactJob { id: string; sessionRef: string; agentKind: string; sourceId: string; href: string; diagnosticsProtocol?: number }
class ArtifactError extends Error {
  constructor(code: string, readonly resource?: string) { super(code); }
}
const extension = (name: string) => extname(name).slice(1).toLowerCase();
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** On Linux walk relative to held directory descriptors, including during directory renames. */
async function readFile(root: string, directory: FileHandle, name: string): Promise<Buffer> {
  const handles: FileHandle[] = [];
  let parent = directory, physical = root;
  try {
    const segments = name.split("/");
    for (const [index, part] of segments.entries()) {
      physical = join(physical, part);
      const anchored = process.platform === "linux" ? `/proc/self/fd/${parent.fd}/${part}` : physical;
      const handle = await open(anchored, flags | (index < segments.length - 1 ? constants.O_DIRECTORY : 0));
      handles.push(handle); parent = handle;
    }
    const stat = await parent.stat();
    if (!stat.isFile()) throw new ArtifactError("file_denied", name);
    if (stat.size <= 0 || stat.size > 20 * 1024 * 1024) throw new ArtifactError("too_large", name);
    const parts: Buffer[] = []; let total = 0;
    for (;;) {
      const part = Buffer.alloc(64 * 1024);
      const { bytesRead } = await parent.read(part, 0, part.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > 20 * 1024 * 1024) throw new ArtifactError("too_large", name);
      parts.push(part.subarray(0, bytesRead));
    }
    // macOS is a development host without procfs. Also recheck the path after
    // the bounded read so a replaced directory cannot publish another file.
    if (process.platform !== "linux") {
      if (await realpath(physical) !== physical) throw new ArtifactError("file_denied", name);
      const current = await lstat(physical);
      if (current.ino !== stat.ino || current.dev !== stat.dev) throw new ArtifactError("file_denied", name);
    }
    return Buffer.concat(parts);
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}

/** Only explicit output links from this exact native conversation are eligible. */
export async function readArtifact(job: Pick<ArtifactJob, "sourceId" | "href" | "diagnosticsProtocol">, messages: readonly Message[]): Promise<AgentArtifactBundle> {
  const message = messages.find(entry => entry.sourceId === job.sourceId && ["agent", "plan"].includes(entry.role));
  const path = localArtifactPath(job.href);
  if (!path || !message || !localArtifactLinks(message.text).includes(job.href)) throw new ArtifactError("reference_missing");
  const entry = basename(path);
  if (!artifactResourceName(entry)) throw new ArtifactError("file_denied");
  if (!ARTIFACT_CONTENT_TYPES[extension(entry)] || /\.(?:css|m?js|woff2?|ttf)$/i.test(entry)) throw new ArtifactError("unsupported", entry);
  let directory: FileHandle;
  let root: string;
  try { root = await realpath(dirname(path)); directory = await open(root, flags | constants.O_DIRECTORY); }
  catch (error) { throw new ArtifactError((error as NodeJS.ErrnoException).code === "ENOENT" ? "file_missing" : "file_denied", entry); }
  try {
    const pending = [entry], seen = new Set<string>(), skipped = new Set<string>();
    const files: AgentArtifactBundle["files"] = []; let total = 0;
    while (pending.length) {
      const name = pending.shift()!;
      if (seen.has(name)) continue;
      if (seen.size + skipped.size >= 64) throw new ArtifactError("too_large", name);
      seen.add(name);
      const contentType = ARTIFACT_CONTENT_TYPES[extension(name)];
      if (!contentType) throw new ArtifactError("unsupported", name);
      let bytes: Buffer;
      try { bytes = await readFile(root, directory, name); }
      catch (error) {
        if (error instanceof ArtifactError) throw error;
        throw new ArtifactError((error as NodeJS.ErrnoException).code === "ENOENT" ? name === entry ? "file_missing" : "resource_missing" : "file_denied", name);
      }
      total += bytes.length;
      if (total > 32 * 1024 * 1024) throw new ArtifactError("too_large", name);
      files.push({ name, contentType, base64: bytes.toString("base64") });
      for (const ref of artifactReferences(bytes.toString("utf8"), contentType)) {
        let resource: string | undefined;
        try { resource = artifactRelativeResource(ref.reference, name); }
        catch { throw new ArtifactError("file_denied"); }
        if (!resource) continue;
        if (ref.download && !ARTIFACT_CONTENT_TYPES[extension(resource)] && job.diagnosticsProtocol === 1) {
          skipped.add(resource);
          if (seen.size + skipped.size > 64) throw new ArtifactError("too_large", name);
        } else pending.push(resource);
      }
    }
    return { entry, files, ...(skipped.size ? { skippedResources: [...skipped] } : {}) };
  } finally { await directory.close(); }
}

// Compatibility names for the existing runner; these now handle all preview types.
export const readImageArtifact = readArtifact;

/** Reads the node's own private dispatch journal; never starts/resumes a source session. */
export async function completeImageArtifacts(root: string, api: Pick<API, "call">): Promise<void> {
  const { jobs } = await api.call("GET", "/api/v1/node/agent-artifacts") as { jobs: ArtifactJob[] };
  for (const job of jobs) {
    let result: { bundle: AgentArtifactBundle } | { error: string; errorResource?: string };
    try {
      const state = directories(join(root, "sessions")).map((key) => readPrivate<HostState>(join(hostDirectory(root, key), "state.json")))
        .find((entry) => entry?.phase === "launched" && entry.sessionRef === job.sessionRef && entry.dispatch.agentKind === job.agentKind);
      if (!state) throw new ArtifactError("node_unavailable");
      result = { bundle: await readImageArtifact(job, state.snapshot.messages) };
    } catch (error) { result = { error: error instanceof ArtifactError ? error.message : "node_unavailable", ...(job.diagnosticsProtocol === 1 && error instanceof ArtifactError && error.resource ? { errorResource: error.resource } : {}) }; }
    await api.call("POST", `/api/v1/node/agent-artifacts/${encodeURIComponent(job.id)}`, result);
  }
}
