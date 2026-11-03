import { randomUUID } from "node:crypto";
import { CLAUDE_CODE_MODES } from "@missiongo/domain";
import { JsonProcess } from "./process.js";
import type { Adapter, Command, Dispatch, Message, Question, Session, Snapshot, Wire } from "./types.js";

export const CLAUDE_DENIALS = ["Bash(git reflog expire:*)", "Bash(git gc --prune=now:*)", "Bash(git push --force:*)", "Bash(git push -f:*)"];
export function claudeArguments(job: Dispatch, ref: string): string[] {
  if (!(CLAUDE_CODE_MODES as readonly string[]).includes(job.mode)) throw new Error("Unsupported Claude mode");
  return ["--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--replay-user-messages",
    "--permission-prompt-tool", "stdio", "--permission-prompts", "host", "--no-chrome",
    "--disallowedTools", CLAUDE_DENIALS.join(","), "--permission-mode", job.mode,
    "--session-id", ref, "--name", `${job.nodeName ?? "Linux"}-${job.itemKeys.join(",")}`,
    ...(job.model ? ["--model", job.model] : []), ...(job.effort ? ["--effort", job.effort] : [])];
}
export function labelledAnswers(text: string): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^(.+?)[:：]\s*(.*)$/.exec(line);
    if (match) answers[match[1]!.trim()] = match[2]!.trim();
  }
  return answers;
}
export function claudeAnswer(request: Wire, text: string): Wire {
  if (request.tool_name === "AskUserQuestion") {
    const questions: Wire[] = request.input?.questions ?? [];
    const labelled = labelledAnswers(text);
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const answer = labelled[q.question] ?? labelled[q.header] ?? (questions.length === 1 ? text : undefined);
      if (answer === undefined) throw new Error("Answer every question by its displayed title");
      answers[q.question] = answer;
    }
    return { behavior: "allow", updatedInput: { ...request.input, answers } };
  }
  const prefix = `授权请求 ${request.requestId}: `;
  const answer = (text.startsWith(prefix) ? text.slice(prefix.length) : text).trim();
  if (text.startsWith("授权请求 ") && !text.startsWith(prefix)) throw new Error("Stale permission request");
  if (["批准", "批准并实施", "approve", "approved", "yes", "proceed"].includes(answer.toLowerCase())) {
    if (JSON.stringify(request.input ?? {}).length > 4000) throw new Error("Permission scope is too long to review; approval was not sent");
    return { behavior: "allow", updatedInput: request.input ?? {} };
  }
  return { behavior: "deny", message: answer || "用户拒绝了这次操作。" };
}
export class ClaudeAdapter implements Adapter {
  private process: JsonProcess;
  private ref = randomUUID();
  private state: Snapshot = { status: "idle", messages: [], turnActive: false };
  private requests: Wire[] = [];
  private waits = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(job: Dispatch, executable: string, env = process.env) {
    this.process = new JsonProcess(executable, claudeArguments(job, this.ref), job.repoPath, env);
    this.process.onEvent = (event) => this.event(event);
    this.process.onClose = () => {
      this.state.status = "unavailable"; this.state.error = "Claude host stopped; no automatic restart";
      for (const wait of this.waits.values()) { clearTimeout(wait.timer); wait.reject(new Error("Claude channel closed")); } this.waits.clear();
    };
  }
  private wait(key: string, timeout = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waits.delete(key); reject(new Error("Claude delivery is unconfirmed; do not resend automatically")); }, timeout);
      this.waits.set(key, { resolve, reject, timer });
    });
  }
  private received(key: string): void {
    const wait = this.waits.get(key); if (!wait) return;
    clearTimeout(wait.timer); this.waits.delete(key); wait.resolve();
  }
  private event(event: Wire): void {
    if (event.type === "control_response") {
      const response = event.response;
      if (response?.subtype === "success") this.received(response.request_id);
      return;
    }
    if (event.type === "system" && event.subtype === "init") {
      if (event.session_id !== this.ref) { this.process.child.kill(); return; }
      this.received("native-id");
    }
    if (event.type === "control_request" && event.request?.subtype === "can_use_tool") {
      this.requests.push({ ...event.request, requestId: event.request_id });
      this.state.waitingForInput = true; return;
    }
    if (event.type === "control_cancel_request") {
      this.requests = this.requests.filter((r) => r.requestId !== event.request_id); return;
    }
    if (event.type === "result") {
      this.state.status = event.is_error ? "failed" : "idle"; this.state.turnActive = false;
    }
    if (["assistant", "user"].includes(event.type)) {
      const message = event.message ?? {};
      const content: Wire[] = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
      const text = content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
      if (text.trim()) this.add({ sourceId: event.uuid ?? randomUUID(), role: event.type === "user" ? "user" : "agent", text });
      if (event.type === "user" && event.uuid) this.received(event.uuid);
      if (event.type === "assistant") { this.state.status = "active"; this.state.turnActive = true; }
    }
  }
  private add(message: Message): void {
    const index = this.state.messages.findIndex((m) => m.sourceId === message.sourceId);
    if (index >= 0) this.state.messages[index] = message; else this.state.messages.push(message);
    this.state.messages = this.state.messages.slice(-1900);
  }
  async start(prompt: string): Promise<string> {
    const requestId = randomUUID(); const ready = this.wait(requestId, 60_000);
    this.process.write({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } });
    await ready;
    const native = this.wait("native-id", 60_000);
    this.send(randomUUID(), prompt);
    await native;
    return this.ref;
  }
  private send(uuid: string, text: string): void {
    this.process.write({ type: "user", uuid, session_id: "", parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text }] } });
    this.state.status = "active"; this.state.turnActive = true;
  }
  async snapshot(): Promise<Snapshot> {
    const messages = [...this.state.messages];
    for (const request of this.requests) {
      const sourceId = `request-${request.requestId}`;
      let questions: Question[];
      if (request.tool_name === "AskUserQuestion") questions = (request.input?.questions ?? []).map((q: Wire) => ({
        title: q.question, ...(q.header ? { header: q.header } : {}), options: (q.options ?? []).map((o: Wire) => o.label), multiSelect: q.multiSelect === true,
      }));
      else questions = [{ title: `Claude Code 请求使用 ${request.tool_name}`, key: `授权请求 ${request.requestId}`,
        detail: JSON.stringify(request.input ?? {}).slice(0, 4000), options: JSON.stringify(request.input ?? {}).length > 4000 ? ["拒绝"] : ["批准", "拒绝"] }];
      messages.push({ sourceId, role: "agent", text: request.tool_name === "ExitPlanMode" ? "计划已准备好，请明确批准或提出修改。" : `Claude Code 请求确认：${request.tool_name}`, questions });
    }
    return { ...this.state, waitingForInput: this.requests.length > 0, messages };
  }
  async deliver(command: Command): Promise<void> {
    if (command.kind === "interrupt") {
      const requestId = randomUUID(); const ack = this.wait(requestId);
      this.process.write({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } }); await ack; return;
    }
    const request = this.requests[0];
    if (request) {
      const response = claudeAnswer(request, command.text);
      // Answers always apply to the live native request, not a remembered tool grant.
      this.process.write({ type: "control_response", response: { subtype: "success", request_id: request.requestId, response } });
      this.requests.shift();
      this.add({ sourceId: `answer-${command.id}`, role: "user", text: command.text });
      return;
    }
    const ack = this.wait(command.id); this.send(command.id, command.text); await ack;
  }
  async decide(): Promise<void> { throw new Error("Use the displayed Claude question to answer this request"); }
  async settings(settings: NonNullable<Session["desiredSettings"]>): Promise<void> {
    if (settings.effort) throw new Error("Changing Claude effort requires a new dispatch");
    if (settings.mode && !(CLAUDE_CODE_MODES as readonly string[]).includes(settings.mode)) throw new Error("Unsupported Claude mode");
    for (const request of [settings.mode ? { subtype: "set_permission_mode", mode: settings.mode } : undefined,
      settings.model ? { subtype: "set_model", model: settings.model } : undefined].filter(Boolean)) {
      const requestId = randomUUID(); const ack = this.wait(requestId);
      this.process.write({ type: "control_request", request_id: requestId, request }); await ack;
    }
  }
  async close(): Promise<void> { this.process.child.kill(); }
}
