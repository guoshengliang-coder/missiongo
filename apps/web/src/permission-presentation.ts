import type { AgentSessionQuestion } from "./types";

export interface PermissionChoice { label: string; detail?: string }

// Presentation only: callers must submit the original option, never this label.
// Restrict legacy decoding to the host's request-bound Claude permission card.
export function permissionPresentation(question: AgentSessionQuestion): Map<string, PermissionChoice> | undefined {
  if (question.header !== "授权请求" || !question.title.startsWith("Claude Code 请求使用 ")
    || !question.key?.startsWith("授权请求 ")) return undefined;
  const result = new Map<string, PermissionChoice>();
  const edit = /请求使用 (Edit|Write|MultiEdit|NotebookEdit)$/.test(question.title);
  for (const option of question.options ?? []) {
    if (option === "批准") result.set(option, { label: edit ? "仅允许这一次修改" : "仅允许这一次操作", detail: "只批准当前请求，不记住额外权限。" });
    if (option === "拒绝") result.set(option, { label: edit ? "拒绝本次修改" : "拒绝本次操作", detail: "不批准当前请求。" });
    const line = question.detail?.split("\n").find(line => line.startsWith(option + "："));
    if (!line) continue;
    let update: Record<string, unknown>;
    try { update = JSON.parse(line.slice(option.length + 1)); } catch { continue; }
    if (!update || typeof update !== "object" || Array.isArray(update)) continue;
    const scopes: Record<string, string> = { session: "本次会话", localSettings: "当前项目本机设置", projectSettings: "当前项目共享设置", userSettings: "用户全局设置" };
    const scope = typeof update.destination === "string" && Object.hasOwn(scopes, update.destination) ? scopes[update.destination] : undefined;
    if (!scope) continue;
    const lifetime = update.destination === "session" ? "仅本次会话有效。" : `保存到${scope}，后续会话也会生效。`;
    if (update.type === "setMode" && update.mode === "acceptEdits") {
      result.set(option, { label: `${scope}修改文件不再询问`, detail: `${lifetime}自动接受文件编辑；其他操作仍按权限规则确认。` });
    } else if ((update.type === "addDirectories" || update.type === "removeDirectories")
      && Array.isArray(update.directories) && update.directories.length > 0
      && update.directories.every(value => typeof value === "string" && value.length > 0)) {
      const add = update.type === "addDirectories";
      result.set(option, { label: `${scope}${add ? "允许" : "取消"}访问指定文件夹`,
        detail: `${update.directories.join("、")}。${lifetime}${add ? "修改是否需要确认，仍按当前权限规则执行。" : "移除这些目录的额外访问范围。"}` });
    } else if (update.type === "addRules" && ["allow", "deny", "ask"].includes(String(update.behavior))
      && Array.isArray(update.rules) && update.rules.length > 0
      && update.rules.every(rule => rule && typeof rule === "object" && typeof rule.toolName === "string"
        && (rule.ruleContent === undefined || typeof rule.ruleContent === "string"))) {
      const action = update.behavior === "allow" ? "自动允许" : update.behavior === "deny" ? "拒绝" : "每次询问";
      const rules = update.rules.map(rule => rule.ruleContent ? `${rule.toolName}（${rule.ruleContent}）` : rule.toolName).join("、");
      result.set(option, { label: `${scope}${action}指定操作`, detail: `${rules}。${lifetime}仅对符合上述规则的操作生效。` });
    }
  }
  return result;
}

// Keep the request-bound wire answer in state, but show the same readable choice
// in the composer. Only exact generated answers are translated; prose is untouched.
export function permissionReplyText(questions: readonly AgentSessionQuestion[], text: string, toWire = false): string {
  for (const question of questions) {
    const choices = permissionPresentation(question);
    if (!choices) continue;
    for (const [original, choice] of choices) {
      const wire = `${question.key}: ${original}`;
      const readable = `${question.key}: ${choice.label}${choice.detail ? `（${choice.detail}）` : ""}`;
      if (text === (toWire ? readable : wire)) return toWire ? wire : readable;
    }
  }
  return text;
}
