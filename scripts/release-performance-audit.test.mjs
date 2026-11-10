import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compilePerformanceCandidate } from "./release-performance-build.mjs";
import { atomicInstallWrite } from "./enable-release-performance.mjs";
import { transferProgram } from "./release-backup.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = () => mkdtempSync(join(tmpdir(), "and489-audit-"));

test("candidate compilation repairs ignored JS that an incremental build leaves stale", () => {
  const dir = temporary();
  try {
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    symlinkSync(join(root, "node_modules/.bin/tsc"), join(dir, "node_modules/.bin/tsc"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { "build:types": "tsc -b" } }));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { composite: true, target: "ES2023", module: "ESNext", outDir: "dist", types: [] }, files: ["sample.ts"] }));
    writeFileSync(join(dir, "sample.ts"), "export const value = 1;\n");
    execFileSync("npm", ["run", "build:types"], { cwd: dir, stdio: "ignore" });
    const output = join(dir, "dist/sample.js"), expected = readFileSync(output, "utf8");
    writeFileSync(output, expected + "// STALE_COMPILED_SENTINEL\n");
    execFileSync("npm", ["run", "build:types"], { cwd: dir, stdio: "ignore" });
    assert.ok(readFileSync(output, "utf8").includes("STALE_COMPILED_SENTINEL"), "Negative control must reproduce the stale artifact");
    compilePerformanceCandidate(dir);
    assert.equal(readFileSync(output, "utf8"), expected);
    writeFileSync(join(dir, "sample.ts"), "export const value: number = 'bad';\n");
    assert.throws(() => compilePerformanceCandidate(dir), "Compile errors must propagate");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("atomic installation preserves old content on partial write or rename failure and cleans siblings", () => {
  const dir = temporary();
  try {
    const path = join(dir, "settings.json"), old = '{"host":"fixture"}\n'; writeFileSync(path, old);
    assert.throws(() => atomicInstallWrite(path, '{"new":true}', { write: (target, _, options) => {
      writeFileSync(target, "{", options); throw new Error("simulated partial disk write");
    } }));
    assert.equal(readFileSync(path, "utf8"), old);
    assert.deepEqual(readdirSync(dir), ["settings.json"]);
    assert.throws(() => atomicInstallWrite(path, '{"new":true}', { rename: () => { throw new Error("simulated rename failure"); } }));
    assert.equal(readFileSync(path, "utf8"), old);
    assert.deepEqual(readdirSync(dir), ["settings.json"]);
    // Backup publication uses a no-clobber hard link after a complete write.
    assert.throws(() => atomicInstallWrite(path, "must not replace an existing backup", { rename: linkSync }), { code: "EEXIST" });
    assert.equal(readFileSync(path, "utf8"), old);
    assert.deepEqual(readdirSync(dir), ["settings.json"]);
    atomicInstallWrite(path, '{"new":true}');
    assert.equal(JSON.parse(readFileSync(path)).new, true);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    atomicInstallWrite(path, "executable", { mode: 0o755 });
    assert.equal(lstatSync(path).mode & 0o777, 0o755);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the actual transfer program validates opened file type and length before sending payload", () => {
  const dir = temporary();
  try {
    const name = "missiongo-20260101T000000Z", folder = join(dir, name); mkdirSync(folder);
    const file = join(folder, "missiongo.sqlite"), bytes = Buffer.alloc(128, 7); writeFileSync(file, bytes);
    const run = (filename, expected) => spawnSync("python3", ["-c", transferProgram, dir, name, filename, String(expected)], { timeout: 5000 });
    const valid = run("missiongo.sqlite", bytes.length);
    assert.equal(valid.status, 0); assert.deepEqual(valid.stdout, bytes);
    for (const expected of [1, bytes.length + 1, 0]) {
      const mismatch = run("missiongo.sqlite", expected);
      assert.notEqual(mismatch.status, 0); assert.equal(mismatch.stdout.length, 0);
    }
    symlinkSync(file, join(folder, "link.sqlite"));
    const link = run("link.sqlite", bytes.length);
    assert.notEqual(link.status, 0); assert.equal(link.stdout.length, 0);
    execFileSync("python3", ["-c", "import os,sys; os.mkfifo(sys.argv[1])", join(folder, "pipe.sqlite")]);
    const fifo = run("pipe.sqlite", bytes.length);
    assert.notEqual(fifo.status, 0); assert.equal(fifo.stdout.length, 0); assert.equal(fifo.error, undefined, "FIFO must reject without waiting for the global deadline");
    assert.equal(existsSync(file), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
