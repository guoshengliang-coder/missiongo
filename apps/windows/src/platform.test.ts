import { afterEach, beforeAll, expect, it } from "vitest";
import { chmodSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, copyFileSync, existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readArtifact } from "../../node/src/artifacts.js";
import { prepareRuntime } from "./runtime.js";
import { acquireNodeLease } from "./lease.js";
import { initializeNativeSecurity } from "./security.js";
import { loadConfig, saveConfig } from "../../node/src/storage.js";
import { agentEnvironment, safeWindowsEnvironment } from "../../node/src/launch.js";
import { probe } from "../../node/src/process.js";
import { detectAgents, verifyRepo } from "../../node/src/runner.js";
import { resolveAgentLaunch } from "../../node/src/environment.js";

const roots: string[] = [];
const temporary = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "mg-win-"))); roots.push(root); return root; };
beforeAll(initializeNativeSecurity);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("keeps an immutable runtime outside an installation and refuses a changed cached host", () => {
  const root = temporary(); const source = join(root, "installation"); mkdirSync(source);
  const node = process.platform === "win32" ? "node.exe" : "node";
  const files = { [node]: "fixture-node", "worker.mjs": "fixture-worker" };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(source, name), text);
  writeFileSync(join(source, "runtime.json"), JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, createHash("sha256").update(text).digest("hex")])) }));
  const saved = prepareRuntime(source, root);
  expect(saved.node.startsWith(source)).toBe(false);
  expect(prepareRuntime(source, root)).toEqual(saved);
  expect(readFileSync(saved.worker, "utf8")).toBe("fixture-worker");
  writeFileSync(saved.worker, "changed");
  expect(() => prepareRuntime(source, root)).toThrow("不能覆盖");
}, 30_000);

it("preserves Windows PATH precedence, skips empty cwd entries and retains provider configuration", () => {
  const env = { Path: "D:\\custom;C:\\toolchain;;", USERPROFILE: "C:\\Users\\fixture", ANTHROPIC_AUTH_TOKEN: "fixture-only", CODEX_HOME: "D:\\profiles\\codex" };
  const next = agentEnvironment(env, "win32");
  expect(next.Path?.startsWith("D:\\custom;C:\\toolchain")).toBe(true);
  expect(next).not.toHaveProperty("PATH"); expect(next.Path).not.toContain(";;");
  expect(next.CODEX_HOME).toBe(env.CODEX_HOME); expect(next.ANTHROPIC_AUTH_TOKEN).toBe(env.ANTHROPIC_AUTH_TOKEN);
  expect(env.Path).toBe("D:\\custom;C:\\toolchain;;");
});

it.skipIf(process.platform !== "win32")("protects the device token with current-user DPAPI and retains the installation identity", () => {
  const root = join(temporary(), "private");
  const initial = loadConfig(root); saveConfig(root, { ...initial, token: "fixture-node-credential", nodeId: "fixture-node" });
  const raw = readFileSync(join(root, "config.json"), "utf8");
  expect(raw).not.toContain("fixture-node-credential"); expect(raw).toContain("protectedToken");
  expect(loadConfig(root)).toMatchObject({ installationId: initial.installationId, token: "fixture-node-credential" });
}, 30_000);

it.skipIf(process.platform !== "win32")("releases the kernel singleton without deleting another owner's lease", async () => {
  const root = temporary(); const release = await acquireNodeLease(root);
  await expect(acquireNodeLease(root)).rejects.toThrow("Another node");
  await release(); await (await acquireNodeLease(root))();
});

it.skipIf(process.platform !== "win32")("executes an npm-style cmd launcher with literal special arguments and the selected Node runtime", async () => {
  const root = temporary(); const script = join(root, "wire.cjs"); const cmd = join(root, "my agent.cmd");
  writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)))");
  writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "%~dp0wire.cjs" %*\r\n`);
  const args = ["--version", "space argument", "x&echo injected", "literal%value!", "%PATH%", "quotes\"inside", "中文"];
  expect(JSON.parse(await probe(cmd, args, root))).toEqual(args);
}, 15_000);

it.skipIf(process.platform !== "win32")("uses PATH precedence instead of a repository's shadow launcher", async () => {
  const root = temporary(); const trusted = join(root, "trusted"); const repo = join(root, "repo"); mkdirSync(trusted); mkdirSync(repo);
  writeFileSync(join(trusted, "fixture-agent.cmd"), "@echo trusted\r\n"); writeFileSync(join(repo, "fixture-agent.cmd"), "@echo repository-shadow\r\n");
  expect(await probe("fixture-agent", [], repo, { ...process.env, Path: trusted, PATH: trusted })).toBe("trusted");
});

it.skipIf(process.platform !== "win32")("uses an explicit PowerShell environment for Codex checks without persisting or echoing secrets", async () => {
  const root = temporary(); const path = join(root, "环境 with spaces.ps1");
  writeFileSync(path, "$env:PROVIDER_FIXTURE='fixture-only-secret'; $env:CODEX_HOME='D:\\fixture profile'; Write-Output 'not-version-output'", "utf8");
  const value = await resolveAgentLaunch("codex", { environmentScript: path });
  expect(value.executable).toBe("codex"); expect(value.env.PROVIDER_FIXTURE).toBe("fixture-only-secret");
  expect(value.env.CODEX_HOME).toBe("D:\\fixture profile");
  writeFileSync(path, "Write-Output 'fixture-only-secret'; throw 'fixture-only-secret'");
  await expect(resolveAgentLaunch("codex", { environmentScript: path })).rejects.toThrow("script failed");
}, 30_000);

it("executes explicitly configured native launchers without interpreting shell text", async () => {
  if (process.platform === "win32") return;
  const root = temporary(); const path = join(root, "custom launcher");
  writeFileSync(path, "#!/bin/sh\nprintf '%s' \"$1\"\n"); chmodSync(path, 0o700);
  expect(await probe(path, ["literal $(false) & ; % ! 中文"])).toBe("literal $(false) & ; % ! 中文");
});


it("strips relative Windows PATH entries and prevents a script from restoring implicit cwd lookup", () => {
  const env = safeWindowsEnvironment({ Path: '.;tools;C:\\trusted;"D:\\space directory";\\root-relative', NoDefaultCurrentDirectoryInExePath: "", NODEFAULTCURRENTDIRECTORYINEXEPATH: "0" });
  expect(env.Path).toBe("C:\\trusted;D:\\space directory");
  expect(env.NoDefaultCurrentDirectoryInExePath).toBe("1"); expect(env).not.toHaveProperty("NODEFAULTCURRENTDIRECTORYINEXEPATH");
});
it.skipIf(process.platform !== "win32")("an authentic npm shim uses trusted PATH Node instead of a repository's node.exe", async () => {
  const root = temporary(); const trusted = join(root, "trusted"); const repo = join(root, "repo"); mkdirSync(trusted); mkdirSync(repo);
  copyFileSync(process.execPath, join(repo, "node.exe"));
  writeFileSync(join(trusted, "wire.cjs"), "console.log(JSON.stringify({ executable: process.execPath, args: process.argv.slice(2) }))");
  writeFileSync(join(trusted, "agent.cmd"), '@ECHO off\r\nSETLOCAL\r\nIF EXIST "%~dp0\\node.exe" (\r\n SET "_prog=%~dp0\\node.exe"\r\n) ELSE (\r\n SET "_prog=node"\r\n SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n"%_prog%" "%~dp0\\wire.cjs" %*\r\n');
  const env = { ...process.env, Path: `${trusted};${join(process.execPath, "..")};.`, PATH: `${trusted};${join(process.execPath, "..")};.`, NoDefaultCurrentDirectoryInExePath: "" };
  const result = JSON.parse(await probe("agent", ["literal & space", "中文"], repo, env));
  expect(realpathSync(result.executable)).toBe(realpathSync(process.execPath)); expect(result.args).toEqual(["literal & space", "中文"]);
  const shebang = join(trusted, "agent-bootstrap");
  writeFileSync(shebang, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ executable: process.execPath, args: process.argv.slice(2) }))');
  const direct = JSON.parse(await probe(shebang, ["literal & space", "中文"], repo, env));
  expect(realpathSync(direct.executable)).toBe(realpathSync(process.execPath)); expect(direct.args).toEqual(result.args);
});
it.skipIf(process.platform !== "win32")("repository verification finds standard Git when the inherited PATH omits it", async () => {
  const root = temporary(); const original = process.env.Path; const originalUpper = process.env.PATH;
  try {
    const systemPath = join(process.env.SystemRoot!, "System32"); process.env.Path = systemPath; process.env.PATH = systemPath;
    await probe("git", ["init", root]); expect(await verifyRepo(root)).toBe(root);
  } finally { if (original === undefined) delete process.env.Path; else process.env.Path = original; if (originalUpper === undefined) delete process.env.PATH; else process.env.PATH = originalUpper; }
});
it.skipIf(process.platform !== "win32")("exports Git Bash paths through native Node while preserving provider values", async () => {
  const root = temporary(); const bash = join(process.env.ProgramFiles!, "Git", "bin", "bash.exe");
  expect(existsSync(bash)).toBe(true);
  const path = join(root, "environment.sh");
  writeFileSync(path, "export PATH=/c/Tools:/usr/bin:/bin\nexport CODEX_HOME='/c/agent profiles/codex'\nexport CLAUDE_CONFIG_DIR='/c/agent profiles/claude'\nexport PROVIDER_FIXTURE='secret=fixture'\n");
  const launch = await resolveAgentLaunch("codex", { environmentScript: path, shellExecutable: bash });
  const envPath = Object.entries(launch.env).find(([key]) => key.toLowerCase() === "path")?.[1];
  expect(envPath).toMatch(/^C:[\\/]Tools;/i); expect(launch.env.CODEX_HOME).toMatch(/^C:[\\/]agent profiles[\\/]codex$/i);
  expect(launch.env.CLAUDE_CONFIG_DIR).toMatch(/^C:[\\/]agent profiles[\\/]claude$/i); expect(launch.env.PROVIDER_FIXTURE).toBe("secret=fixture");
}, 15_000);

it.skipIf(process.platform !== "win32")("reads an ordinary artifact bundle but denies a junction resource",async()=>{
  const root=temporary(); const assets=join(root,"assets");const outside=join(root,"outside");mkdirSync(assets);mkdirSync(outside);
  const page=join(root,"report.html");writeFileSync(page,'<img src="assets/image.png">');writeFileSync(join(assets,"image.png"),"fixture");
  const job={sourceId:"message",href:page};const messages=[{sourceId:"message",role:"agent" as const,text:`[Report](<${page}>)`}];
  expect((await readArtifact(job,messages)).files).toHaveLength(2);
  symlinkSync(outside,join(root,"escape"),"junction");writeFileSync(join(outside,"image.png"),"private");writeFileSync(page,'<img src="escape/image.png">');
  await expect(readArtifact(job,messages)).rejects.toThrow("file_denied");
});

it.skipIf(process.platform !== "win32")("identifies real native shim protocols and rejects Node selected as an Agent",async()=>{
  const root=temporary();const agent=join(root,"fixture.cjs"),launcher=join(root,"agent.cmd");
  copyFileSync(fileURLToPath(new URL("../../node/src/fixtures/agent.cjs",import.meta.url)),agent);
  writeFileSync(launcher,`@echo off\r\n"${process.execPath}" "%~dp0fixture.cjs" %*\r\n`);
  const profile=join(root,"profile");const skill=join(profile,"skills","missiongo");mkdirSync(skill,{recursive:true});writeFileSync(join(skill,"SKILL.md"),"---\nversion: 1.0.0\n---\nfixture");
  const env=join(root,"environment.ps1"),quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
  writeFileSync(env,`$env:USERPROFILE=${quote(root)}; $env:HOME=${quote(root)}; $env:CODEX_HOME=${quote(profile)}; $env:CLAUDE_CONFIG_DIR=${quote(profile)}`);
  const config={installationId:"fixture",server:"https://missiongo.example.com",agents:{codex:{executable:launcher,environmentScript:env},claude_code:{executable:launcher,environmentScript:env}}};
  const ready=await detectAgents(config,"1.0.0");expect(ready).toHaveLength(2);
  expect(ready.every(entry=>entry.ready && entry.planApprovalProtocol === 1 && entry.version === "1.0.0")).toBe(true);
  expect((await detectAgents({...config,agents:{codex:{executable:process.execPath}}},"1.0.0"))[0]?.ready).toBe(false);
},60_000);
