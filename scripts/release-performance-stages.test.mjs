import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { fetchBackup, discoverBackupProgram, transferProgram } from "./release-backup.mjs";
import { stageRecorder, readStageProgress, temporaryDataBytes } from "./release-performance-stages.mjs";
import { runReleasePerformance } from "./release-performance.mjs";
import { validateBudget } from "./performance-budget.mjs";
import { runPerformanceGroup } from "./performance-watchdog.mjs";

const root = new URL("../", import.meta.url);
const budget = JSON.parse(readFileSync(new URL("tests/performance/server-budgets.json", root)));
const temporary = () => mkdtempSync(join(tmpdir(), "and505-stage-test-"));
const manifest = bytes => ({ formatVersion: 1, directory: "missiongo-20260101T000000Z", createdAt: "2026-01-01T00:00:00Z", database: {
  filename: "missiongo.sqlite", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } });

function fakeSsh(dir, metadata, compressed) {
  const ssh = join(dir, "ssh");
  writeFileSync(ssh, `#!/usr/bin/env python3\nimport sys,base64\nif 'MISSIONGO_BACKUP_TRANSFER_V2' in sys.argv[-1]: sys.stdout.buffer.write(base64.b64decode('${compressed.toString("base64")}'))\nelse: print(${JSON.stringify(JSON.stringify(metadata))})\n`, { mode: 0o700 });
  return ssh;
}

test("compressed transfer retains provenance, detects corrupt/truncated/hash-invalid data and bounds decompression", async () => {
  const dir = temporary();
  try {
    const bytes = Buffer.from("complete backup".repeat(1024)), m = manifest(bytes);
    for (const [name, data, edit, pattern] of [
      ["valid", gzipSync(bytes), () => {}, null],
      ["hash", gzipSync(Buffer.alloc(bytes.length, 7)), () => {}, /digest mismatch/],
      ["short", gzipSync(bytes.subarray(0, 4)), () => {}, /size mismatch/],
      ["bomb", gzipSync(Buffer.alloc(bytes.length * 2)), () => {}, /size mismatch/],
      ["truncated", gzipSync(bytes).subarray(0, 20), () => {}, /unexpected end/i],
      ["corrupt", Buffer.from("not gzip"), () => {}, /header check/i],
      ["oversize", gzipSync(bytes), v => v.database.sizeBytes = bytes.length + 1, /resource limit/],
    ]) {
      const folder = join(dir, name); mkdirSync(folder);
      const metadata = structuredClone(m); edit(metadata);
      const ssh = fakeSsh(dir, metadata, data), stages = [];
      const run = () => fetchBackup({ host: "fixture", backupsDir: "/fixture/backups", directory: folder, ssh, maxBackupBytes: bytes.length, stage: s => stages.push(s) });
      if (pattern) await assert.rejects(run, pattern);
      else {
        const value = await run();
        assert.deepEqual(readFileSync(value.database), bytes);
        assert.equal(value.backup.sha256, m.database.sha256);
        assert.equal(value.backup.directory, m.directory);
        assert.equal(value.backup.filename, m.database.filename);
        assert.equal(value.backup.transferredBytes, data.length);
        assert.equal(value.backup.sizeBytes, bytes.length);
        assert.deepEqual(stages, ["discovery", "transfer", "validation"]);
      }
      if (pattern) assert.equal(existsSync(join(folder, "work.sqlite")), false);
    }
    const diskFolder = join(dir, "disk-corrupt"); mkdirSync(diskFolder);
    const ssh = fakeSsh(dir, m, gzipSync(bytes));
    await assert.rejects(() => fetchBackup({ host: "fixture", backupsDir: "/fixture/backups", directory: diskFolder, ssh,
      stage: name => { if (name === "validation") writeFileSync(join(diskFolder, "snapshot.sqlite"), Buffer.alloc(bytes.length, 9)); },
    }), /digest mismatch/);
    assert.equal(existsSync(join(diskFolder, "work.sqlite")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("125MiB synthetic backup streams through the actual remote compressor without a persistent archive", async () => {
  const dir = temporary();
  try {
    const folder = join(dir, "missiongo-20260101T000000Z"); mkdirSync(folder);
    const chunk = Buffer.alloc(1024 * 1024, 7), hash = createHash("sha256");
    const fd = openSync(join(folder, "missiongo.sqlite"), "w", 0o600);
    try { for (let i = 0; i < 125; i++) { writeSync(fd, chunk); hash.update(chunk); } } finally { closeSync(fd); }
    const m = manifest(Buffer.from("unused")); m.database.sizeBytes = 125 * chunk.length; m.database.sha256 = hash.digest("hex");
    writeFileSync(join(folder, "manifest.json"), JSON.stringify(m));
    const ssh = join(dir, "ssh");
    writeFileSync(ssh, `#!/usr/bin/env python3\nimport sys,shlex,subprocess\na=shlex.split(sys.argv[-1])\nassert a[:4]==['sudo','-n','python3','-c']\nassert a[4] in [${JSON.stringify(discoverBackupProgram)},${JSON.stringify(transferProgram)}]\nassert a[5]==${JSON.stringify(dir)}\nsys.exit(subprocess.run(['python3','-c',*a[4:]]).returncode)\n`, { mode: 0o700 });
    const destination = join(dir, "download"); mkdirSync(destination);
    const value = await fetchBackup({ host: "fixture", backupsDir: dir, directory: destination, ssh });
    assert.equal(value.backup.sizeBytes, 125 * chunk.length);
    assert.ok(value.backup.transferredBytes < value.backup.sizeBytes / 10);
    assert.ok(temporaryDataBytes(destination) === 250 * chunk.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stage deadlines distinguish preparation from measurement and cleanup failures never pass", async () => {
  const dir = temporary();
  try {
    mkdirSync(join(dir, "tests/performance"), { recursive: true });
    writeFileSync(join(dir, "tests/performance/server-budgets.json"), JSON.stringify(budget));
    for (const stage of ["discovery", "transfer", "validation", "compile", "measurement"]) {
      let clock = 0, seen;
      const report = await runReleasePerformance({ root: dir }, { now: () => clock, runGroup: async (args, _, options) => {
        seen = args.at(-2);
        const recorder = stageRecorder(seen); recorder.start(stage);
        options.monitor(); clock = 120001;
        const violation = options.monitor();
        assert.equal(violation.kind, stage === "measurement" ? "measurement" : "preparation");
        return { violation, status: null };
      } });
      assert.equal(report.stage, stage); assert.equal(report.status, "invalid");
      assert.equal(report.failureKind, stage === "measurement" ? "measurement" : "preparation");
      assert.equal(report.cleaned, true); assert.equal(existsSync(seen), false);
      assert.equal(report.stages.at(-1).name, "cleanup");
    }
    let seen;
    const failed = await runReleasePerformance({ root: dir }, { cleanup: async () => false, runGroup: async args => {
      seen = args.at(-2); writeFileSync(join(seen, "result.json"), '{"status":"passed"}'); return { status: 0 };
    } });
    assert.equal(failed.cleaned, false); assert.equal(failed.status, "invalid"); assert.equal(failed.failureKind, "cleanup");
    rmSync(seen, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resource inspection rejects overflow during work and budget v2 cannot silently bypass stages", () => {
  const dir = temporary();
  try {
    const recorder = stageRecorder(dir); recorder.start("discovery"); recorder.start("transfer");
    assert.equal(readStageProgress(dir).stage, "transfer");
    assert.equal(readStageProgress(dir).stages[0].status, "passed");
    writeFileSync(join(dir, "data"), Buffer.alloc(1024));
    assert.throws(() => temporaryDataBytes(dir, 100), /limit exceeded/);
    const old = structuredClone(budget); old.release.version = 2; old.release.maxDurationMs = 120000;
    assert.throws(() => validateBudget(old), /contract/);
    for (const key of ["preparationMs", "measurementMs", "cleanupMs", "maxBackupBytes", "maxTempBytes"]) {
      const invalid = structuredClone(budget); invalid.release[key] *= 2; assert.throws(() => validateBudget(invalid));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real monitor stops growing temporary data and cancellation kills descendants before deleting snapshots", async () => {
  const dir = temporary();
  try {
    mkdirSync(join(dir, "tests/performance"), { recursive: true });
    writeFileSync(join(dir, "tests/performance/server-budgets.json"), JSON.stringify(budget));
    const worker = join(dir, "worker.mjs"), seen = join(dir, "seen"), escaped = join(dir, "escaped"), ready = join(dir, "ready");
    const recorderUrl = new URL("./release-performance-stages.mjs", import.meta.url).href;
    const prefix = `import fs from 'node:fs'; import {join} from 'node:path'; import {stageRecorder} from ${JSON.stringify(recorderUrl)}; const dir=process.argv[2]; fs.writeFileSync(${JSON.stringify(seen)},dir); stageRecorder(dir).start('transfer');`;
    writeFileSync(worker, prefix + `const fd=fs.openSync(join(dir,'oversize'),'w');fs.ftruncateSync(fd,${budget.release.maxTempBytes + 1});fs.closeSync(fd);while(true){}`);
    const over = await runReleasePerformance({ root: dir }, { worker });
    assert.equal(over.status, "invalid"); assert.equal(over.failureKind, "resource"); assert.equal(over.stage, "transfer");
    assert.ok(over.peakTempBytes > budget.release.maxTempBytes);
    assert.equal(over.cleaned, true); assert.equal(existsSync(readFileSync(seen, "utf8")), false);
    writeFileSync(worker, prefix + `import {spawn} from 'node:child_process';spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(escaped)},'bad'),1500)`)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(ready)},'child spawned');while(true){}`);
    const cancelled = await runReleasePerformance({ root: dir }, { worker, runGroup: (args, _, options) => runPerformanceGroup(args, 2000, {
      ...options, monitor: () => {
        const violation = options.monitor();
        if (existsSync(ready)) process.emit("SIGTERM");
        return violation;
      },
    }) });
    assert.equal(readFileSync(ready, "utf8"), "child spawned");
    assert.equal(cancelled.failureKind, "cancelled"); assert.equal(cancelled.cleaned, true);
    assert.equal(existsSync(readFileSync(seen, "utf8")), false);
    await new Promise(resolve => setTimeout(resolve, 1600)); assert.equal(existsSync(escaped), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
