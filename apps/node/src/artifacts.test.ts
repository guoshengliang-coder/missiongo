import { expect, it } from "vitest";
import { mkdtemp, writeFile, symlink, rm, mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readImageArtifact, completeImageArtifacts } from "./artifacts.js";
import { privateDir, savePrivate } from "./storage.js";
import { hostDirectory } from "./host.js";
import type { HostState, Message } from "./types.js";

it("reads only an explicit same-message image and refuses unreferenced files, user input, symlinks and non-images", async () => {
  const root = await mkdtemp(join(tmpdir(), "mg-images-"));
  try {
    const path = join(root, "image.png"); await writeFile(path, "fixture");
    const job = { sourceId: "image", href: path };
    const messages: Message[] = [{ sourceId: "image", role: "agent", text: `![image](<${path}>)` }];
    const result = await readImageArtifact(job, messages);
    expect(result.files[0]).toEqual({ name: "image.png", contentType: "image/png", base64: Buffer.from("fixture").toString("base64") });
    await expect(readImageArtifact({ ...job, sourceId: "other" }, messages)).rejects.toThrow("reference_missing");
    await expect(readImageArtifact(job, [{ ...messages[0]!, role: "user" }])).rejects.toThrow("reference_missing");
    const alias = join(root, "alias.png"); await symlink(path, alias);
    await expect(readImageArtifact({ sourceId: "image", href: alias }, [{ ...messages[0]!, text: `![image](<${alias}>)` }])).rejects.toThrow("file_denied");
    const secret = join(root, "private.sh");
    await expect(readImageArtifact({ sourceId: "image", href: secret }, [{ ...messages[0]!, text: `[file](<${secret}>)` }])).rejects.toThrow("unsupported");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("uploads an output from its bound private session journal without starting a runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "mg-image-worker-"));
  try {
    const path = join(root, "output.png"); await writeFile(path, "fixture");
    const directory = hostDirectory(root, "dispatch"); privateDir(directory);
    savePrivate(join(directory, "state.json"), { phase: "launched", sessionRef: "native", dispatch: { agentKind: "codex" },
      snapshot: { messages: [{ sourceId: "image", role: "agent", text: `![image](<${path}>)` }] } } as HostState);
    const jobs = [ { id: "image", sessionRef: "native", agentKind: "codex", sourceId: "image", href: path },
      { id: "wrong", sessionRef: "other", agentKind: "codex", sourceId: "image", href: path } ];
    const reports: unknown[] = [];
    await completeImageArtifacts(root, { call: async (method: string, _path: string, body?: unknown) => {
      if (method === "GET") return { jobs }; reports.push(body); return undefined;
    } });
    expect(reports).toMatchObject([{ bundle: { entry: "output.png" } }, { error: "node_unavailable" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const output = (path: string, diagnosticsProtocol = 1) => ({ job: { sourceId: "output", href: path, diagnosticsProtocol },
  messages: [{ sourceId: "output", role: "agent", text: `[preview](<${path}>)` }] as Message[] });

it("packages HTML/CSS/modules and skips only unknown download links with bounded diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "mg-artifacts-"));
  try {
    await mkdir(join(root, "assets"));
    const path = join(root, "report.html");
    await writeFile(path, `<link rel="stylesheet" href="assets/site.css"><img src="assets/image.png"><script type="module">import './app.js'; const example="url(fake.png)";</script><a href=evidence.jsonl download>Evidence</a><a href="notes.md">Notes</a>`);
    await writeFile(join(root, "assets/site.css"), "body{background:url(image.png)}");
    await writeFile(join(root, "assets/image.png"), "image");
    await writeFile(join(root, "app.js"), "export const ready=true;");
    await writeFile(join(root, "notes.md"), "# Notes\n![image](assets/image.png)\n[Evidence](evidence.jsonl)");
    const f = output(path);
    const bundle = await readImageArtifact(f.job, f.messages);
    expect(bundle.files.map(file => file.name).sort()).toEqual(["app.js", "assets/image.png", "assets/site.css", "notes.md", "report.html"]);
    expect(bundle.skippedResources).toEqual(["evidence.jsonl"]);
    await expect(readImageArtifact({ sourceId: f.job.sourceId, href: f.job.href }, f.messages)).rejects.toThrow("unsupported");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("reports exact missing or unsupported dependencies and rejects encoded escapes and symlink directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "mg-artifact-errors-"));
  try {
    const path = join(root, "report.html"), f = output(path);
    for (const [body, code, resource] of [
      ['<link href="missing.css">', "resource_missing", "missing.css"],
      ['<link href=missing.css>', "resource_missing", "missing.css"],
      ['<img src="missing.png">', "resource_missing", "missing.png"],
      ['<script type="module">import "./evidence.jsonl";</script>', "unsupported", "evidence.jsonl"],
      ['<a href="%2e%2e/outside.jsonl">download</a>', "file_denied", undefined],
      ['<a href="%2fetc/passwd.jsonl">download</a>', "file_denied", undefined],
      ['<img src=".secret.png">', "file_denied", undefined],
    ] as const) {
      await writeFile(path, body);
      await expect(readImageArtifact(f.job, f.messages)).rejects.toMatchObject({ message: code, resource });
    }
    await symlink(root, join(root, "linked"));
    await writeFile(path, '<img src="linked/report.html">');
    await expect(readImageArtifact(f.job, f.messages)).rejects.toThrow("file_denied");
    const pdf = join(root, "report.pdf"); await writeFile(pdf, "%PDF-1.4\n%%EOF");
    const p = output(pdf); expect((await readImageArtifact(p.job, p.messages)).files[0]?.contentType).toBe("application/pdf");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("enforces single-file, combined-byte and resource-count limits including skipped links", async () => {
  const root = await mkdtemp(join(tmpdir(), "mg-artifact-limits-"));
  try {
    const big = join(root, "big.txt"), b = output(big), handle = await open(big, "w");
    await handle.truncate(20 * 1024 * 1024); await handle.close();
    expect((await readImageArtifact(b.job, b.messages)).files).toHaveLength(1);
    const grown = await open(big, "r+"); await grown.truncate(20 * 1024 * 1024 + 1); await grown.close();
    await expect(readImageArtifact(b.job, b.messages)).rejects.toThrow("too_large");
    const path = join(root, "report.html"), f = output(path);
    await writeFile(path, Array.from({ length: 63 }, (_, n) => `<a href="${n}.jsonl">data</a>`).join(""));
    expect((await readImageArtifact(f.job, f.messages)).skippedResources).toHaveLength(63);
    await writeFile(path, Array.from({ length: 64 }, (_, n) => `<a href="${n}.jsonl">data</a>`).join(""));
    await expect(readImageArtifact(f.job, f.messages)).rejects.toThrow("too_large");
    for (const name of ["one.png", "two.png"]) { const h = await open(join(root, name), "w"); await h.truncate(17 * 1024 * 1024); await h.close(); }
    await writeFile(path, '<img src="one.png"><img src="two.png">');
    await expect(readImageArtifact(f.job, f.messages)).rejects.toThrow("too_large");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("reports diagnostics only when the existing job advertises the new protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "mg-artifact-worker-"));
  try {
    const path = join(root, "report.html"); await writeFile(path, '<img src="missing.png">');
    const directory = hostDirectory(root, "dispatch"); privateDir(directory);
    savePrivate(join(directory, "state.json"), { phase: "launched", sessionRef: "native", dispatch: { agentKind: "codex" },
      snapshot: { messages: [{ sourceId: "report", role: "agent", text: `[report](<${path}>)` }] } } as HostState);
    const job = { id: "report", sessionRef: "native", agentKind: "codex", sourceId: "report", href: path };
    const reports: unknown[] = [];
    await completeImageArtifacts(root, { call: async (method: string, _path: string, body?: unknown) => {
      if (method === "GET") return { jobs: [job, { ...job, id: "new", diagnosticsProtocol: 1 }] };
      reports.push(body); return undefined;
    } });
    expect(reports).toEqual([{ error: "resource_missing" }, { error: "resource_missing", errorResource: "missing.png" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
