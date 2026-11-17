// Bounded CI diagnostics using only owned synthetic files and fixed programs.
// Never run an Agent, read its profile, or print inherited environment values.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, openSync, fstatSync, lstatSync, closeSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import crossSpawn from "cross-spawn";

if (process.platform !== "win32") {
  console.log("Native synthetic diagnostics require Windows; not executed.");
} else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mg-native-diagnostic-")));
  const report = {};
  const capture = result => ({ status: result.status, error: result.error?.code ?? null,
    stdout: String(result.stdout ?? "").replaceAll(root, "<fixture>").slice(0, 2000),
    stderr: String(result.stderr ?? "").replaceAll(root, "<fixture>").slice(0, 4000) });
  const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const run = (source, input) => spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")],
    { input: JSON.stringify(input) + "\n", encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
  try {
    report.stdin = capture(run("$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $r=[Console]::In.ReadLine() | ConvertFrom-Json; [Console]::Out.WriteLine(($r | ConvertTo-Json -Compress))", { value: "synthetic 中文" }));
    const source = readFileSync(new URL("../apps/windows/src/security.ts", import.meta.url), "utf8").match(/const program = `([\s\S]*?)`;/)?.[1];
    const bootstrap = readFileSync(new URL("../apps/node/src/launch.ts", import.meta.url), "utf8").match(/export const windowsPowerShellBootstrap = `([^`]+)`;/)?.[1];
    if (!source || !bootstrap) throw new Error("Fixed security program unavailable");
    report.privateDirectory = capture(run(bootstrap + source, { action: "directory", path: join(root, "private", "nested") }));
    const file = join(root, "fixture.txt"); writeFileSync(file, "synthetic");
    report.fileBeforeAssignment = capture(run(bootstrap + source, { action: "file", path: file }));
    report.createdFile = capture(run(bootstrap + source, { action: "created_file", path: file }));
    report.fileAfterAssignment = capture(run(bootstrap + source, { action: "file", path: file }));
    const protectedValue = run(bootstrap + source, { action: "protect", value: "synthetic-only" });
    report.protect = capture(protectedValue);
    if (protectedValue.status === 0) report.unprotect = capture(run(bootstrap + source, { action: "unprotect", value: JSON.parse(protectedValue.stdout.trim()) }));
    const fd = openSync(file, "r");
    try {
      const path = lstatSync(file, { bigint: true }), handle = fstatSync(fd, { bigint: true });
      report.identity = { path: { ino: String(path.ino), dev: String(path.dev) }, handle: { ino: String(handle.ino), dev: String(handle.dev) } };
    } finally { closeSync(fd); }
    writeFileSync(join(root, "fixture.cjs"), "console.log(JSON.stringify(process.argv.slice(2)))");
    const launcher = join(root, "agent with spaces.cmd");
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "%~dp0fixture.cjs" %*\r\n`);
    report.cmd = capture(crossSpawn.sync(launcher, ["synthetic", "中文"], { cwd: root, env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" }, encoding: "utf8", timeout: 15000 }));
    for (const detached of [false, true]) {
      report[`cmdAsyncDetached${detached}`] = await new Promise(resolve => {
        const child = crossSpawn(launcher, ["synthetic", "中文"], { cwd: root, env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" }, detached, stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
        let stdout = "", stderr = "";
        child.stdout.on("data", b => { stdout += b.toString(); }); child.stderr.on("data", b => { stderr += b.toString(); });
        child.on("error", error => resolve(capture({ error })));
        child.on("close", status => resolve(capture({ status, stdout, stderr })));
      });
    }
    report.knownGit = Object.fromEntries(["ProgramFiles", "PROGRAMFILES", "ProgramW6432"].map(key => [key, Boolean(process.env[key] && existsSync(join(process.env[key], "Git", "cmd", "git.exe")))]));
    report.nodeDirectoryPresent = existsSync(dirname(process.execPath));
    console.log(JSON.stringify(report, null, 2));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
