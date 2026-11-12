/** Personal text snippets; never executed until the user sends the composed message. */
export const COMMON_COMMAND_CONTENT_LIMIT = 3000;
export const COMMON_COMMAND_NAME_LIMIT = 20;
export const COMMON_COMMAND_COUNT_LIMIT = 200;
export interface CommonCommand { id: string; content: string; name: string; favorite: boolean }
export interface CommonCommands { revision: number; commands: CommonCommand[] }
export type CommonCommandAction =
  | { kind: "create"; content: string; name: string; favorite: boolean }
  | { kind: "edit"; id: string; content: string; name: string; favorite: boolean }
  | { kind: "delete"; id: string }
  | { kind: "favorite"; id: string; favorite: boolean }
  | { kind: "move"; id: string; direction: "up" | "down" };
