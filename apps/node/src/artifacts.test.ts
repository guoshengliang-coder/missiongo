import { expect, it } from "vitest";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
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
    const secret = join(root, "private.txt");
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
