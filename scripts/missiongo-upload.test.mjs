import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectFile, uploadFile } from "../apps/web/public/downloads/missiongo-upload.mjs";

const helper = fileURLToPath(new URL("../apps/web/public/downloads/missiongo-upload.mjs", import.meta.url));

test("CLI inspection of a large file emits only small metadata, never encoded bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "missiongo-upload-cli-"));
  try {
    const file = join(root, "trace.log");
    const bytes = Buffer.alloc(794_572, 65);
    await writeFile(file, bytes);
    const result = spawnSync(process.execPath, [helper, "inspect", file], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.length < 300);
    assert.deepEqual(JSON.parse(result.stdout), { filename: "trace.log", contentType: "text/plain", sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") });
    assert.equal(result.stderr, "");
  } finally { await rm(root, { recursive: true }); }
});

test("a changed local file is rejected before any upload request", async () => {
  const root = await mkdtemp(join(tmpdir(), "missiongo-upload-cli-"));
  try {
    const file = join(root, "trace.log");
    await writeFile(file, "original");
    const metadata = await inspectFile(file);
    await writeFile(file, "tampered");
    let requests = 0;
    await assert.rejects(uploadFile(file, { ...metadata, uploadId: randomUUID() }, {
      fetchImpl: () => { requests++; throw new Error("should never fetch"); },
    }), /does not match/);
    assert.equal(requests, 0);
  } finally { await rm(root, { recursive: true }); }
});

test("invalid private JSON cannot leak an upload capability into command output", async () => {
  const root = await mkdtemp(join(tmpdir(), "missiongo-upload-cli-"));
  try {
    const file = join(root, "trace.log");
    const spec = join(root, "spec.json");
    const capability = "example-capability-that-must-never-be-printed";
    await writeFile(file, "original");
    await writeFile(spec, capability, { mode: 0o600 });
    const result = spawnSync(process.execPath, [helper, "upload", file, spec], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(capability));
    assert.match(result.stderr, /private upload spec/);
  } finally { await rm(root, { recursive: true }); }
});
