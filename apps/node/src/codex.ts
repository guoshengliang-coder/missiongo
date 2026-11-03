import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { JsonProcess } from "./process.js";
import { localArtifactPath } from "@missiongo/domain";
import { pathToFileURL } from "node:url";
import { worktreePath } from "./prompt.js";
import type { Adapter, Approval, Command, Dispatch, Message, Session, Snapshot, Wire } from "./types.js";
import { id, object, InputRejected } from "./types.js";

export function codexPolicy(mode: string) {
  if (!["plan", "auto", "default"].includes(mode)) throw new Error("Unsupported Codex mode");
  return { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: mode === "default" ? "user" : "auto_review" };
}
export function validatePolicy(result: Wire, job: Dispatch): void {
  const policy = codexPolicy(job.mode);
  if (result.approvalPolicy !== policy.approvalPolicy || result.approvalsReviewer !== policy.approvalsReviewer
    || result.cwd !== job.repoPath || result.sandbox?.type !== "workspaceWrite"
    || !Array.isArray(result.sandbox.writableRoots) || !Array.isArray(result.runtimeWorkspaceRoots)
    || ![job.repoPath, worktreePath(job)].every((root) => result.runtimeWorkspaceRoots.includes(root)
      && [result.cwd, ...result.sandbox.writableRoots].includes(root))) {
    throw new Error("Codex did not confirm the exact workspace and reviewer policy; no task started");
  }
}
export function codexMessages(thread: Wire): Message[] {
  const messages: Message[] = [];
  for (const turn of thread.turns ?? []) for (const item of turn.items ?? []) {
    const sourceId = `${turn.id}:${item.id}`;
    if (item.type === "userMessage") {
      const text = (item.content ?? []).filter((c: Wire) => c.type === "text").map((c: Wire) => c.text).join("\n");
      if (text.trim()) messages.push({ sourceId, turnId: turn.id, role: "user", text });
    } else if (item.type === "imageGeneration" && item.status === "completed" && !item.failure
      && typeof item.savedPath === "string" && localArtifactPath(item.savedPath)
      && /\.(?:png|jpe?g|gif|webp|svg)$/i.test(item.savedPath)) {
      messages.push({ sourceId, turnId: turn.id, role: "agent", text: `![image](<${pathToFileURL(item.savedPath).href}>)` });
    } else if (["agentMessage", "plan"].includes(item.type) && item.text?.trim()) {
      messages.push({ sourceId, turnId: turn.id, role: item.type === "plan" ? "plan" : "agent", text: item.text });
    }
  }
  return messages.slice(-2000);
}
export class CodexAdapter implements Adapter {
  private rpc: JsonProcess;
  private ref = "";
  private pending = new Map<string, { rpcId: unknown; snapshot: Approval; results: Map<string, unknown> }>();
  private closed = false;
  private lastApproval: Approval | undefined;
  constructor(private job: Dispatch, executable: string, private localSkillVersion?: string) {
    this.rpc = new JsonProcess(executable, ["app-server"], job.repoPath);
    this.rpc.onClose = () => {
      this.closed = true;
      const active = this.pending.values().next().value?.snapshot;
      if (active) { active.status = "unavailable"; this.lastApproval = active; }
      this.pending.clear();
    };
    this.rpc.onEvent = (event) => this.request(event);
  }
  private request(event: Wire): void {
    if (event.params?.threadId !== this.ref) return;
    if (["item/autoApprovalReview/started", "item/autoApprovalReview/completed"].includes(event.method)) {
      const p = object(event.params);
      if (typeof p.reviewId === "string" && typeof p.turnId === "string" && p.review?.status && p.action) {
        this.lastApproval = { id: p.reviewId, kind: "auto", status: p.review.status, turnId: p.turnId,
          action: String(p.action.command ?? p.action.target ?? p.action.toolName ?? p.action.type ?? "action").slice(0, 4000),
          ...(p.review.rationale ? { reason: String(p.review.rationale).slice(0, 2000) } : {}), startedAtMs: p.startedAtMs ?? Date.now() };
      }
      return;
    }
    if (event.method === "turn/completed") {
      for (const [key, pending] of this.pending) if (pending.snapshot.turnId === event.params.turn?.id) {
        pending.snapshot.status = "resolved"; this.lastApproval = pending.snapshot; this.pending.delete(key);
      }
      return;
    }
    if (event.method === "serverRequest/resolved") {
      for (const [key, pending] of this.pending) if (pending.rpcId === event.params.requestId) {
        pending.snapshot.status = "resolved"; this.lastApproval = pending.snapshot; this.pending.delete(key);
      }
      return;
    }
    if (event.id === undefined || event.params?.threadId !== this.ref) return;
    const p = object(event.params);
    const results = new Map<string, unknown>();
    const options: NonNullable<Approval["options"]> = [];
    const add = (choice: string, kind: string, result: unknown, label?: string) => {
      options.push({ id: choice, kind, ...(label ? { label } : {}) }); results.set(choice, result);
    };
    if (event.method === "item/commandExecution/requestApproval" || event.method === "item/fileChange/requestApproval") {
      const offered = p.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"];
      if (Array.isArray(offered)) for (const choice of offered) {
        if (["accept", "acceptForSession", "decline", "cancel"].includes(choice) && !(p.kind === "humanCommand" && choice === "acceptForSession")) {
          add(choice, choice === "accept" ? "once" : choice === "acceptForSession" ? "session" : choice, { decision: choice });
        }
      }
    } else if (event.method === "item/permissions/requestApproval") {
      add("accept", "turn", { permissions: p.permissions, scope: "turn" });
      add("decline", "decline", { permissions: {}, scope: "turn" });
    } else if (["item/tool/requestUserInput", "tool/requestUserInput"].includes(event.method)) {
      const question = p.questions?.[0];
      if (p.questions?.length === 1 && !question.isSecret && question.id) {
        for (const [i, choice] of (question.options ?? []).entries()) {
          if (typeof choice.label === "string") add(`choice-${i}`, "choice", { answers: { [question.id]: { answers: [choice.label] } } }, choice.label);
        }
      }
    } else if (event.method === "mcpServer/elicitation/request") {
      const schema = p.requestedSchema;
      if (["form", "openai/form"].includes(p.mode) && schema?.type === "object"
        && (schema.properties === undefined || (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)))
        && Object.keys(schema.properties ?? {}).length === 0 && Array.isArray(schema.required ?? []) && (schema.required ?? []).length === 0
        && Object.keys(schema).every((key) => ["type", "properties", "required", "additionalProperties", "title", "description"].includes(key))) {
        add("accept", "once", { action: "accept", content: {} }); add("decline", "decline", { action: "decline", content: null });
      }
    } else return;
    const approvalId = randomUUID();
    const action = p.command ?? p.grantRoot ?? p.questions?.[0]?.question ?? p.message ?? JSON.stringify(p.permissions ?? {});
    this.pending.set(approvalId, { rpcId: event.id, results,
      snapshot: { id: approvalId, kind: "manual", status: options.length && String(action).length <= 4000 ? "pending" : "unavailable",
        action: String(action).slice(0, 4000), turnId: p.turnId ?? "thread-scoped", startedAtMs: Date.now(), options } });
  }
  async start(prompt: string): Promise<string> {
    this.job = { ...this.job, repoPath: realpathSync(this.job.repoPath) };
    if (existsSync(worktreePath(this.job))) throw new Error("Dispatch worktree path already exists");
    await this.rpc.call("initialize", { clientInfo: { name: "missiongo_linux", version: "1" }, capabilities: { experimentalApi: true } });
    this.rpc.write({ method: "initialized" });
    const result = await this.rpc.call("thread/start", { cwd: realpathSync(this.job.repoPath), ...codexPolicy(this.job.mode),
      runtimeWorkspaceRoots: [this.job.repoPath, worktreePath(this.job)], ...(this.job.model ? { model: this.job.model } : {}) });
    this.ref = id(result.thread?.id);
    validatePolicy(result, this.job);
    const response = await this.rpc.call("mcpServer/tool/call", { threadId: this.ref, server: "missiongo", tool: "get_current_account", arguments: {} });
    const account = response.structuredContent ?? JSON.parse(response.content?.find((c: Wire) => c.type === "text")?.text ?? "{}");
    if (response.isError || account.capabilities?.canComment !== true || !account.capabilities?.writeTools?.includes("claim_item") || !account.capabilities?.writeTools?.includes("append_comment")) {
      throw new Error("Authorize MissionGo read/write in Codex before dispatching");
    }
    if (this.localSkillVersion && account.skill?.expectedVersion !== this.localSkillVersion) throw new Error("Codex MissionGo Skill differs from the connected server; no task started");
    await this.rpc.call("thread/name/set", { threadId: this.ref, name: `${this.job.nodeName ?? "Linux"}-${this.job.itemKeys.join(",")}` });
    await this.rpc.call("turn/start", this.turn(prompt, this.job.dispatchId));
    return this.ref;
  }
  private turn(text: string, commandId: string): Wire {
    return { threadId: this.ref, input: [{ type: "text", text }], clientUserMessageId: commandId,
      ...(this.job.model ? { model: this.job.model } : {}), ...(this.job.effort ? { effort: this.job.effort } : {}),
      approvalPolicy: "on-request", approvalsReviewer: codexPolicy(this.job.mode).approvalsReviewer };
  }
  async snapshot(): Promise<Snapshot> {
    if (this.closed) return { status: "unavailable", messages: [], error: "Codex control host disconnected; no automatic restart", ...(this.lastApproval ? { approval: this.lastApproval } : {}) };
    const { thread } = await this.rpc.call("thread/read", { threadId: this.ref, includeTurns: true });
    const active = (thread.turns ?? []).some((turn: Wire) => turn.status === "inProgress");
    const approval = this.pending.values().next().value?.snapshot ?? this.lastApproval;
    const lastTurn = thread.turns?.at(-1);
    return { status: active ? "active" : lastTurn?.status === "failed" ? "failed" : "idle", messages: codexMessages(thread), turnActive: active,
      waitingForInput: approval?.status === "pending", ...(approval ? { approval } : {}) };
  }
  async deliver(command: Command): Promise<void> {
    if (command.kind === "interrupt") {
      const { thread } = await this.rpc.call("thread/read", { threadId: this.ref, includeTurns: true });
      const turn = thread.turns?.find((t: Wire) => t.status === "inProgress");
      if (turn) await this.rpc.call("turn/interrupt", { threadId: this.ref, turnId: turn.id });
      return;
    }
    if (this.pending.size) throw new Error("Answer the pending request explicitly before sending another message");
    const { thread } = await this.rpc.call("thread/read", { threadId: this.ref, includeTurns: true });
    const turn = thread.turns?.find((t: Wire) => t.status === "inProgress");
    if (turn) await this.rpc.call("turn/steer", { threadId: this.ref, expectedTurnId: turn.id,
      input: [{ type: "text", text: command.text }], clientUserMessageId: command.id });
    else await this.rpc.call("turn/start", this.turn(command.text, command.id));
  }
  async decide(decision: { id: string; choice: string }): Promise<void> {
    const request = this.pending.get(decision.id);
    if (!request || request.snapshot.status !== "pending" || !request.results.has(decision.choice)) throw new Error("Stale or unsupported approval choice");
    this.rpc.write({ id: request.rpcId, result: request.results.get(decision.choice) });
    request.snapshot.status = ["decline", "cancel"].includes(decision.choice) ? "denied" : "approved";
    this.lastApproval = request.snapshot; this.pending.delete(decision.id);
  }
  async settings(settings: NonNullable<Session["desiredSettings"]>): Promise<void> {
    if (settings.mode) codexPolicy(settings.mode);
    const updated = { ...this.job, ...settings };
    await this.rpc.call("thread/resume", { threadId: this.ref, ...codexPolicy(updated.mode), ...(updated.model ? { model: updated.model } : {}) });
    this.job = updated;
  }
  async archive(restore: boolean): Promise<void> { await this.rpc.call(restore ? "thread/unarchive" : "thread/archive", { threadId: this.ref }); }
  async retryApproval(retry: NonNullable<Session["approvalRetry"]>): Promise<void> {
    if (this.lastApproval?.kind !== "auto" || this.lastApproval.status !== "denied" || this.lastApproval.id !== retry.reviewId) throw new InputRejected("Auto-review retry no longer matches the denied source request");
    const { thread } = await this.rpc.call("thread/read", { threadId: this.ref, includeTurns: true });
    if (thread.turns?.some((turn: Wire) => turn.status === "inProgress")) throw new InputRejected("Wait for the current turn to finish before retrying");
    await this.rpc.call("turn/start", { ...this.turn("用户已在 MissionGo 控制台明确要求对刚被自动审查拒绝的操作发起一次人工审批重试。请重新评估，只尝试一次，并将实际授权请求交给人审查。不要重复其他操作。", retry.id), approvalsReviewer: "user" });
  }
  async close(): Promise<void> { this.rpc.child.kill(); }
}
