import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cacheIdentity, inputs, restoreInputTimes, snapshot } from "./macos-ci-cache.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mg-swift-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "apps/macos/Sources"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".build/\n");
  writeFileSync(join(root, "apps/macos/Package.swift"), "manifest");
  writeFileSync(join(root, "apps/macos/Sources/main.swift"), "original");
  execFileSync("git", ["add", "."], { cwd: root });
  return root;
}

test("keys ignore checkout mtimes and isolate changed content, modes and toolchains", () => {
  const files = [{ file: "main.swift", hash: "abc", mode: 420, mtime: 1 }];
  const base = cacheIdentity(files, { swift: "6", root: "checkout-a", arch: "arm64" });
  assert.deepEqual(cacheIdentity([{ ...files[0], mtime: 100 }], { swift: "6", root: "checkout-a", arch: "arm64" }), base);
  for (const changed of [{ hash: "def" }, { mode: 493 }]) {
    const next = cacheIdentity([{ ...files[0], ...changed }], { swift: "6", root: "checkout-a", arch: "arm64" });
    assert.notEqual(next.key, base.key); assert.equal(next.prefix, base.prefix);
  }
  for (const toolchain of [{ swift: "7" }, { root: "checkout-b" }, { arch: "x86_64" }]) {
    assert.notEqual(cacheIdentity(files, { swift: "6", root: "checkout-a", arch: "arm64", ...toolchain }).prefix, base.prefix);
  }
});

test("cold preparation normalizes times; warm preparation restores only unchanged tracked input", t => {
  const root = fixture(t), source = join(root, "apps/macos/Sources/main.swift");
  assert.equal(restoreInputTimes(root), 0);
  const original = statSync(source).mtimeMs;
  assert.equal(original % 1000, 0);
  snapshot(root);
  utimesSync(source, new Date(), new Date(original + 60_000));
  assert.equal(restoreInputTimes(root), 2);
  assert.equal(statSync(source).mtimeMs, original);
  writeFileSync(source, "changed source");
  assert.equal(restoreInputTimes(root), 1);
  assert.equal(readFileSync(source, "utf8"), "changed source");
  assert.equal(inputs(root).length, 2);
});

test("malformed state and cached paths outside current inputs cannot write arbitrary files", t => {
  const root = fixture(t), secret = join(root, "untouched");
  writeFileSync(secret, "unchanged"); utimesSync(secret, new Date(1000), new Date(1000));
  const state = join(root, "apps/macos/.build/ci-input-mtimes.json");
  mkdirSync(join(root, "apps/macos/.build"));
  for (const payload of ["not json", "null", JSON.stringify({ version: 1, files: [null, { file: "../../../untouched", hash: "guess", mode: 420, mtime: 5000 }] })]) {
    writeFileSync(state, payload);
    assert.equal(restoreInputTimes(root), 0);
    assert.equal(statSync(secret).mtimeMs, 1000);
  }
});
