import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyWindowsAuthenticode } from "./windows-authenticode.mjs";

test("Windows signature inspection uses its own built-in modules despite an inherited module path", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "mg-authenticode-"));
  try {
    const path = join(directory, "unsigned fixture.ps1");
    writeFileSync(path, "# unsigned test fixture; never executed\n");
    const env = { ...process.env, PSModulePath: directory };
    assert.equal(verifyWindowsAuthenticode({ path, unsigned: true }, { env }), "");
    assert.throws(() => verifyWindowsAuthenticode({ path, unsigned: false, publisher: "Fixture" }, { env }));
    assert.throws(() => verifyWindowsAuthenticode({ path: join(directory, "missing.ps1"), unsigned: true }, { env }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
