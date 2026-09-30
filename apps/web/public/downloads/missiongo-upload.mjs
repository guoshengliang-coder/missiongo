#!/usr/bin/env node
// Only metadata and completion are printed; file bytes stay out of model context.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const CHUNK_BYTES = 512 * 1024;
const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", heic: "image/heic", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  log: "text/plain", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  html: "text/html", htm: "text/html", pdf: "application/pdf", zip: "application/zip" };

export async function inspectFile(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size < 1) throw new Error("Choose a nonempty regular file.");
  const filename = basename(path);
  const extension = filename.split(".").at(-1).toLowerCase();
  const contentType = TYPES[extension];
  if (!contentType) throw new Error("Unsupported attachment type.");
  const maxMiB = ["mp4", "mov", "webm", "zip"].includes(extension) ? 100
    : ["log", "txt", "md", "csv", "json", "html", "htm"].includes(extension) ? 10 : 20;
  if (info.size > maxMiB * 1024 * 1024) throw new Error(`File exceeds the ${maxMiB} MiB limit.`);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return { filename, contentType, sizeBytes: info.size, sha256: hash.digest("hex") };
}

/** spec is prepare_attachment_upload.structuredContent, saved in a private file. */
export async function uploadFile(path, spec, { fetchImpl = fetch, retryDelayMs = 500 } = {}) {
  const metadata = await inspectFile(path);
  if (metadata.filename !== spec.filename || metadata.sizeBytes !== spec.sizeBytes || metadata.sha256 !== spec.sha256) {
    throw new Error("Local file does not match the authorized filename, size and SHA-256.");
  }
  const url = new URL(spec.uploadUrl);
  if (url.username || url.password || url.search || url.hash
    || !/^\/api\/v1\/mcp-attachment-uploads\/[0-9a-f-]{36}$/i.test(url.pathname)
    || url.pathname.split("/").at(-1) !== spec.uploadId
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("Expected a trusted HTTPS file upload URL (HTTP is allowed only on loopback).");
  }
  if (typeof spec.uploadToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(spec.uploadToken)
    || !Number.isFinite(Date.parse(spec.tokenExpiresAt)) || Date.parse(spec.tokenExpiresAt) <= Date.now()) {
    throw new Error("Upload capability is missing or expired; prepare the same upload again.");
  }
  let offset = spec.receivedBytes;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > metadata.sizeBytes || spec.chunkBytes !== CHUNK_BYTES) {
    throw new Error("Invalid upload progress or chunk limit.");
  }
  const file = await open(path, "r");
  let complete = spec.complete === true && offset === metadata.sizeBytes;
  try {
    while (offset < metadata.sizeBytes) {
      const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, metadata.sizeBytes - offset));
      let read = 0;
      while (read < bytes.length) {
        const result = await file.read(bytes, read, bytes.length - read, offset + read);
        if (!result.bytesRead) throw new Error("Local file changed during upload.");
        read += result.bytesRead;
      }
      const chunkUrl = new URL(url);
      chunkUrl.searchParams.set("offsetBytes", String(offset));
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        response = undefined;
        try {
          response = await fetchImpl(chunkUrl, { method: "PUT", redirect: "error",
            signal: AbortSignal.timeout(60_000),
            headers: { authorization: `Bearer ${spec.uploadToken}`, "content-type": "application/octet-stream" },
            body: bytes });
        } catch {
          if (attempt === 2) throw new Error("Upload request failed; prepare the same upload ID to resume.");
        }
        if (response && response.status < 500) break;
        if (attempt < 2) await sleep(retryDelayMs * 2 ** attempt);
      }
      if (!response?.ok) throw new Error(`Upload rejected (HTTP ${response?.status ?? "unknown"}); no attachment was associated.`);
      let progress;
      try { progress = await response.json(); }
      catch { throw new Error("Server returned invalid upload progress JSON."); }
      if (progress.uploadId !== spec.uploadId || !Number.isSafeInteger(progress.receivedBytes)
        || progress.receivedBytes < offset + bytes.length || progress.receivedBytes > metadata.sizeBytes
        || progress.complete !== (progress.receivedBytes === metadata.sizeBytes)) {
        throw new Error("Server returned invalid upload progress.");
      }
      offset = progress.receivedBytes;
      complete = progress.complete;
    }
  } finally { await file.close(); }
  if (!complete) throw new Error("Upload has not been verified complete.");
  return { uploadId: spec.uploadId, receivedBytes: offset, complete: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, file, specPath, ...extra] = process.argv.slice(2);
    if (extra.length || !file || (mode !== "inspect" && mode !== "upload") || (mode === "upload" && !specPath)) {
      throw new Error("Usage: node missiongo-upload.mjs inspect <file> | upload <file> <private-spec.json>");
    }
    if (mode === "inspect" && specPath) throw new Error("inspect accepts one file.");
    if (specPath && process.platform !== "win32" && ((await stat(specPath)).mode & 0o077)) {
      throw new Error("Capability spec must be private; chmod 600 the file first.");
    }
    let spec;
    if (mode === "upload") {
      try { spec = JSON.parse(await readFile(specPath, "utf8")); }
      catch { throw new Error("Could not read a valid private upload spec JSON file."); }
    }
    const result = mode === "inspect" ? await inspectFile(file) : await uploadFile(file, spec);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
