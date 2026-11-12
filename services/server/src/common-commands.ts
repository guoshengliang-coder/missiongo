import { createHash, randomUUID } from "node:crypto";
import { COMMON_COMMAND_CONTENT_LIMIT, COMMON_COMMAND_NAME_LIMIT, COMMON_COMMAND_COUNT_LIMIT, type CommonCommand, type CommonCommands } from "@missiongo/contracts";
import { conflict, invalidInput, notFound } from "./errors.js";
import type { MissionGoDatabase } from "./storage/database.js";
export const COMMON_COMMAND_SCHEMA = `
CREATE TABLE account_common_commands (account_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, commands_json TEXT NOT NULL) STRICT;
CREATE TABLE common_command_requests (account_id TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(account_id,request_id)) STRICT;
`;
export class CommonCommandStore {
  constructor(private readonly db: MissionGoDatabase) {}
  list(account: string): CommonCommands {
    const row = this.db.connection.prepare("SELECT revision,commands_json FROM account_common_commands WHERE account_id=?").get(account) as { revision: number; commands_json: string } | undefined;
    return row ? { revision: row.revision, commands: JSON.parse(row.commands_json) as CommonCommand[] } : { revision: 0, commands: [] };
  }
  change(account: string, input: Record<string, unknown>): CommonCommands {
    const key = input.requestId;
    if (typeof key !== "string" || !/^[\w-]{16,100}$/.test(key)) throw invalidInput("Invalid command request identifier.");
    const raw = input.action;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalidInput("Invalid command action.");
    const action = raw as Record<string, unknown>;
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return this.db.transaction(() => {
      const prior = this.db.connection.prepare("SELECT digest FROM common_command_requests WHERE account_id=? AND request_id=?").get(account, key) as { digest: string } | undefined;
      if (prior) { if (prior.digest !== digest) throw conflict("common_commands_conflict", "Command request changed."); return this.list(account); }
      const current = this.list(account);
      if (!Number.isSafeInteger(input.revision) || input.revision !== current.revision) throw conflict("common_commands_conflict", "Commands changed on another device. Reload before saving.");
      const commands = current.commands;
      const fields = () => {
        const content = action.content, name = action.name;
        if (typeof content !== "string" || !content.trim() || [...content.trim()].length > COMMON_COMMAND_CONTENT_LIMIT || typeof name !== "string" || [...name.trim()].length > COMMON_COMMAND_NAME_LIMIT || typeof action.favorite !== "boolean") throw invalidInput("Invalid command content, short name or favorite.");
        return { content: content.trim(), name: name.trim(), favorite: action.favorite };
      };
      if (action.kind === "create") {
        if (commands.length >= COMMON_COMMAND_COUNT_LIMIT) throw invalidInput("Command count limit reached.");
        commands.push({ id: randomUUID(), ...fields() });
      } else {
        const index = commands.findIndex(c => c.id === action.id);
        if (index < 0) throw notFound("Command not found.");
        const command = commands[index]!;
        switch (action.kind) {
          case "edit": Object.assign(command, fields()); break;
          case "delete": commands.splice(index, 1); break;
          case "favorite":
            if (typeof action.favorite !== "boolean") throw invalidInput("Invalid command favorite.");
            command.favorite = action.favorite; break;
          case "move": {
            if (action.direction !== "up" && action.direction !== "down") throw invalidInput("Invalid command move.");
            const target = index + (action.direction === "up" ? -1 : 1);
            if (target >= 0 && target < commands.length) [commands[index],commands[target]] = [commands[target]!,command];
            break;
          }
          default: throw invalidInput("Invalid command action.");
        }
      }
      this.db.connection.prepare("INSERT INTO account_common_commands VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,commands_json=excluded.commands_json").run(account,current.revision+1,JSON.stringify(commands));
      this.db.connection.prepare("INSERT INTO common_command_requests VALUES (?,?,?)").run(account,key,digest);
      return { revision: current.revision+1, commands };
    });
  }
}
