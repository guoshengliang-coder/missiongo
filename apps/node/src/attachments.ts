import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { API } from "./api.js";
import type { Command } from "./types.js";
import { id } from "./types.js";
import { privateDir } from "./storage.js";

export async function prepareAttachments(root: string, sessionId: string, command: Command, api: Pick<API, "bytes">): Promise<Command> {
  if (!command.attachments?.length) return command;
  if (command.kind === "interrupt" || command.attachments.length > 10) throw new Error("Invalid attachment command");
  const directory = join(root, "attachments", id(sessionId), id(command.id)); privateDir(directory);
  const attachments: NonNullable<Command["attachments"]> = [];
  for (const attachment of command.attachments) {
    if (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes <= 0 || attachment.sizeBytes > 100 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(attachment.sha256)) throw new Error("Invalid attachment metadata");
    const extension = extname(attachment.filename).replace(/[^.a-z0-9]/gi, "").slice(0, 20);
    const path = join(directory, id(attachment.id) + extension);
    const valid = (bytes: Buffer) => bytes.length === attachment.sizeBytes && createHash("sha256").update(bytes).digest("hex") === attachment.sha256;
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== attachment.sizeBytes || !valid(readFileSync(path))) throw new Error("Previously downloaded attachment changed; delivery was not attempted");
    } else {
      const bytes = await api.bytes(`/api/v1/node/agent-sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachment.id)}/content`, attachment.sizeBytes);
      if (!valid(bytes)) throw new Error("Attachment digest or size did not match");
      const temp = `${path}.${randomUUID()}.tmp`;
      const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path);
    }
    attachments.push({ ...attachment, localPath: path });
  }
  const lines = attachments.map((attachment) => `- ${JSON.stringify(attachment.filename)} (${attachment.kind}, ${attachment.sizeBytes} bytes): ${JSON.stringify(attachment.localPath)}`);
  return { ...command, attachments, text: `${command.text}\n\n[MissionGo attachment command ${command.id}]\nThe user attached these original files. Read them from the local paths as needed:\n${lines.join("\n")}` };
}
