import { messageTimestamp } from "./message-time.js";
import { sessionName } from "./session-name.js";
import { codexHistory } from "./codex-history.js";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { JsonProcess } from "./process.js";
import { normalizeAgentMode, localArtifactPath } from "@missiongo/domain";
import { pathToFileURL } from "node:url";
import { worktreePath } from "./prompt.js";
import type { Adapter, Approval, Command, Dispatch, Message, Session, Snapshot, Wire } from "./types.js";
import { id, object, InputRejected } from "./types.js";

export function codexPolicy(mode: string) {
  mode=normalizeAgentMode("codex",mode);
  if (!["auto", "default", "read-only"].includes(mode)) throw new Error("Unsupported Codex mode or managed-workspace policy");
  return { sandbox: mode==="read-only" ? "read-only" : "workspace-write", approvalPolicy: "on-request", approvalsReviewer: mode === "auto" ? "auto_review" : "user" };
}
export function validatePolicy(result: Wire, job: Dispatch): void {
  const policy = codexPolicy(job.mode);
  const roots=[job.repoPath,worktreePath(job)];
  if (result.approvalPolicy !== policy.approvalPolicy || result.approvalsReviewer !== policy.approvalsReviewer
    || result.cwd !== job.repoPath || result.sandbox?.type !== (policy.sandbox==="read-only" ? "readOnly" : "workspaceWrite")
    || !Array.isArray(result.runtimeWorkspaceRoots) || !roots.every(root=>result.runtimeWorkspaceRoots.includes(root))
    || policy.sandbox==="workspace-write" && (!Array.isArray(result.sandbox.writableRoots)
      || !roots.every(root=>[result.cwd,...result.sandbox.writableRoots].includes(root)))) {
    throw new Error("Codex did not confirm the exact workspace and reviewer policy; no task started");
  }
}
export function codexMessages(thread: Wire): Message[] {
  const messages: Message[] = [];
  for (const turn of thread.turns ?? []) for (const item of turn.items ?? []) {
    const sourceId = `${turn.id}:${item.id}`;
    const occurredAt = messageTimestamp(item.createdAt ?? item.created_at ?? item.timestamp ?? turn.startedAt);
    const dated = occurredAt ? { occurredAt } : {};
    if (item.type === "userMessage") {
      const text = (item.content ?? []).filter((c: Wire) => c.type === "text").map((c: Wire) => c.text).join("\n");
      if (text.trim()) messages.push({ sourceId, turnId: turn.id, role: "user", text, ...dated });
    } else if (item.type === "imageGeneration" && item.status === "completed" && !item.failure
      && typeof item.savedPath === "string" && localArtifactPath(item.savedPath)
      && /\.(?:png|jpe?g|gif|webp|svg)$/i.test(item.savedPath)) {
      messages.push({ sourceId, turnId: turn.id, role: "agent", text: `![image](<${pathToFileURL(item.savedPath).href}>)`, ...dated });
    } else if (["agentMessage", "plan"].includes(item.type) && item.text?.trim()) {
      messages.push({ sourceId, turnId: turn.id, role: item.type === "plan" ? "plan" : "agent", text: item.text, ...(item.phase ? { phase: item.phase } : {}), ...dated });
    }
  }
  return messages;
}
export class CodexAdapter implements Adapter {
  private rpc: JsonProcess;
  private ref = "";
  private model = "";
  initialTurnId?: string;
  private pending = new Map<string, { rpcId: unknown; snapshot: Approval; results: Map<string, unknown> }>();
  private closed = false;
  private lastApproval: Approval | undefined;
  private lastMessages: Message[] = [];
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
    let incompleteOptions = false;
    let requestKind: "question" | "permission" | "confirmation" | undefined;
    const add = (choice: string, kind: string, result: unknown, label?: string, detail?: string) => {
      if (detail && detail.length > 4000) {
        incompleteOptions = true;
        detail = "选项说明超出当前入口展示上限，请在原生端阅读并回答。";
      }
      options.push({ id: choice, kind, ...(label ? { label } : {}), ...(detail ? { detail } : {}) }); results.set(choice, result);
    };
    if (event.method === "item/commandExecution/requestApproval" || event.method === "item/fileChange/requestApproval") {
      requestKind = "permission";
      const offered = p.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"];
      if (Array.isArray(offered)) for (const choice of offered) {
        if (["accept", "acceptForSession", "decline", "cancel"].includes(choice) && !(p.kind === "humanCommand" && choice === "acceptForSession")) {
          add(choice, choice === "accept" ? "once" : choice === "acceptForSession" ? "session" : choice, { decision: choice });
        }
      }
    } else if (event.method === "item/permissions/requestApproval") {
      requestKind = "permission";
      add("accept", "turn", { permissions: p.permissions, scope: "turn" });
      add("decline", "decline", { permissions: {}, scope: "turn" });
    } else if (["item/tool/requestUserInput", "tool/requestUserInput"].includes(event.method)) {
      requestKind = "question";
      const question = p.questions?.[0];
      if (p.questions?.length === 1 && !question.isSecret && question.id) {
        for (const [i, choice] of (question.options ?? []).entries()) {
          if (typeof choice.label === "string") add(`choice-${i}`, "choice", { answers: { [question.id]: { answers: [choice.label] } } }, choice.label, typeof choice.description === "string" ? choice.description : undefined);
        }
      }
    } else if (event.method === "mcpServer/elicitation/request") {
      requestKind = "confirmation";
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
      snapshot: { id: approvalId, kind: "manual", status: options.length && !incompleteOptions && String(action).length <= 4000 ? "pending" : "unavailable",
        action: String(action).slice(0, 4000), turnId: p.turnId ?? "thread-scoped", startedAtMs: Date.now(),
        ...(requestKind ? { requestKind } : {}), options } });
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
    this.model=result.model ?? this.job.model ?? "";
    if(!this.model) throw new Error("Codex did not confirm the selected model");
    const response = await this.rpc.call("mcpServer/tool/call", { threadId: this.ref, server: "missiongo", tool: "get_current_account", arguments: {} });
    const account = response.structuredContent ?? JSON.parse(response.content?.find((c: Wire) => c.type === "text")?.text ?? "{}");
    if (response.isError || account.capabilities?.canComment !== true || !account.capabilities?.writeTools?.includes("claim_item") || !account.capabilities?.writeTools?.includes("append_comment")) {
      throw new Error("Authorize MissionGo read/write in Codex before dispatching");
    }
    if (this.localSkillVersion && account.skill?.expectedVersion !== this.localSkillVersion) throw new Error("Codex MissionGo Skill differs from the connected server; no task started");
    await this.rpc.call("thread/name/set", { threadId: this.ref, name: sessionName(this.job) });
    const first = await this.rpc.call("turn/start", this.turn(prompt, this.job.dispatchId));
    this.initialTurnId = first.turn?.id;
    return this.ref;
  }
  private turn(text: string, commandId: string): Wire {
    return { threadId: this.ref, input: [{ type: "text", text }], clientUserMessageId: commandId,
      ...(this.job.model ? { model: this.job.model } : {}), ...(this.job.effort ? { effort: this.job.effort } : {}),
      approvalPolicy:"on-request",approvalsReviewer:codexPolicy(this.job.mode).approvalsReviewer,
      sandboxPolicy:this.job.mode==="read-only" ? {type:"readOnly"} : {
        type:"workspaceWrite",writableRoots:[this.job.repoPath,worktreePath(this.job)],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false},
      collaborationMode:{mode:"default",settings:{model:this.model,reasoning_effort:this.job.effort ?? null,developer_instructions:null}} };
  }
  async snapshot(): Promise<Snapshot> {
    if (this.closed) return { status: "unavailable", messages: [], error: "Codex control host disconnected; no automatic restart", ...(this.lastApproval ? { approval: this.lastApproval } : {}) };
    const { thread, lastTurn } = await this.runtime();
    const active = thread.status?.type === "active" || lastTurn?.status === "inProgress";
    const approval = this.pending.values().next().value?.snapshot ?? this.lastApproval;
    let history: NonNullable<Snapshot["history"]>;
    try {
      const page = await codexHistory((method, params) => this.rpc.call(method, params), this.ref);
      this.lastMessages = page.messages;
      history = { ...(page.nextCursor ? { cursor: page.nextCursor } : {}), complete: !page.nextCursor && !page.error,
        ...(page.error ? { error: page.error } : {}) };
    } catch { history = { complete: false, error: "unavailable" }; }
    return { status: active ? "active" : lastTurn?.status === "failed" ? "failed" : "idle", messages: this.lastMessages, turnActive: active, history,
      ...(history.error ? { error: "codex_history_limited: visible item history could not be read" } : {}),
      mode:normalizeAgentMode("codex",this.job.mode), waitingForInput: approval?.status === "pending", ...(approval ? { approval } : {}) };
  }
  private async runtime(): Promise<{ thread: Wire; lastTurn: Wire | undefined }> {
    const { thread } = await this.rpc.call("thread/read", { threadId: this.ref, includeTurns: false });
    if (thread?.id !== this.ref) throw new Error("Codex returned a different thread");
    const page = await this.rpc.call("thread/turns/list", { threadId: this.ref, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
    if (!Array.isArray(page.data)) throw new Error("Invalid Codex turn metadata");
    return { thread, lastTurn: page.data[0] };
  }
  async historyPage(cursor: string) {
    const page = await codexHistory((method, params) => this.rpc.call(method, params), this.ref, cursor);
    // A partial page is useful and its continuation can be retried separately.
    return { messages: page.messages, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  async stop(command: Command): Promise<Snapshot> {
    const target = command.turnId === "startup" ? this.initialTurnId : command.turnId;
    if (!target) throw new InputRejected("停止未发送：原回合标识不可用");
    const observe = async () => {
      const { thread } = await this.rpc.call("thread/read", { threadId: this.ref, includeTurns: false });
      const state = typeof thread.status === "string" ? thread.status : thread.status?.type;
      return state ?? ((thread.turns ?? []).some((t: Wire) => t.status === "inProgress") ? "active" : thread.turns ? "idle" : "unknown");
    };
    if (await observe().catch(() => "unknown") === "idle") return { status: "idle", turnActive: false, messages: [] };
    for (const [key, request] of this.pending) if (request.snapshot.turnId === target) {
      this.rpc.write({ id: request.rpcId, result: request.results.get("decline")
        ?? (request.snapshot.requestKind === "question" ? { answers: {} } : { decision: "decline" }) });
      this.pending.delete(key);
    }
    let failure: unknown;
    try { await this.rpc.call("turn/interrupt", { threadId: this.ref, turnId: target }); } catch (error) { failure = error; }
    if (await observe().catch(() => "unknown") === "idle") return { status: "idle", turnActive: false, messages: [] };
    throw new Error(`停止尚未确认：${failure instanceof Error ? failure.message : "来源未报告原回合结束"}`);
  }
  async deliver(command: Command, options?: { controlOnly: boolean }): Promise<void> {
    if (command.kind === "interrupt") { await this.stop(command); return; }
    if (options?.controlOnly) throw new InputRejected("回复未发送：会话设置未确认，请重新应用设置后重试。");
    if (this.pending.size) throw new Error("Answer the pending request explicitly before sending another message");
    const { lastTurn } = await this.runtime();
    const turn = lastTurn?.status === "inProgress" ? lastTurn : undefined;
    if (turn) await this.rpc.call("turn/steer", { threadId: this.ref, expectedTurnId: turn.id,
      input: [{ type: "text", text: command.text }], clientUserMessageId: command.id });
    else await this.rpc.call("turn/start", this.turn(command.text, command.id));
  }
  async decide(decision: { id: string; choice: string }): Promise<void> {
    const request = this.pending.get(decision.id);
    if (!request || request.snapshot.status !== "pending" || !request.results.has(decision.choice)) throw new Error("Stale or unsupported approval choice");
    this.rpc.write({ id: request.rpcId, result: request.results.get(decision.choice) });
    // An answered question resolves the prompt; it is not a permission grant (AND-408).
    request.snapshot.status = ["decline", "cancel"].includes(decision.choice) ? "denied"
      : request.snapshot.requestKind === "question" ? "resolved" : "approved";
    this.lastApproval = request.snapshot; this.pending.delete(decision.id);
  }
  async settings(settings: NonNullable<Session["desiredSettings"]>): Promise<void> {
    if (settings.mode) codexPolicy(settings.mode);
    const updated = { ...this.job, ...settings };
    const policy = codexPolicy(updated.mode);
    let result=await this.rpc.call("thread/resume", { threadId: this.ref, excludeTurns: true, ...policy, ...(updated.model ? { model: updated.model } : {}) });
    if (result.thread?.id !== this.ref) throw new InputRejected("Codex resumed a different native thread; settings were not applied");
    try { validatePolicy(result, updated); }
    catch {
      // Loaded threads may ignore resume overrides. Do not unload or send a
      // turn to apply permissions: update explicitly, then verify live state.
      if (result.thread?.status?.type === "active" || result.thread?.turns?.some((turn: Wire) => turn.status === "inProgress")) {
        throw new InputRejected("Wait for the current Codex turn before changing permissions");
      }
      await this.rpc.call("thread/settings/update", { threadId: this.ref, approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: policy.approvalsReviewer,
        sandboxPolicy: policy.sandbox === "read-only" ? { type: "readOnly", networkAccess: false }
          : { type: "workspaceWrite", writableRoots: [updated.repoPath, worktreePath(updated)], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        ...(updated.model ? { model: updated.model } : {}), ...(updated.effort ? { effort: updated.effort } : {}) });
      result = await this.rpc.call("thread/resume", { threadId: this.ref, excludeTurns: true });
      if (result.thread?.id !== this.ref) throw new InputRejected("Codex resumed a different native thread; settings were not confirmed");
    }
    validatePolicy(result,updated);
    this.model=result.model ?? updated.model ?? this.model;
    this.job = updated;
  }
  async archive(restore: boolean): Promise<void> { await this.rpc.call(restore ? "thread/unarchive" : "thread/archive", { threadId: this.ref }); }
  async retryApproval(retry: NonNullable<Session["approvalRetry"]>): Promise<void> {
    if (this.lastApproval?.kind !== "auto" || this.lastApproval.status !== "denied" || this.lastApproval.id !== retry.reviewId) throw new InputRejected("Auto-review retry no longer matches the denied source request");
    const { lastTurn } = await this.runtime();
    if (lastTurn?.status === "inProgress") throw new InputRejected("Wait for the current turn to finish before retrying");
    await this.rpc.call("turn/start", { ...this.turn("用户已在 MissionGo 控制台明确要求对刚被自动审查拒绝的操作发起一次人工审批重试。请重新评估，只尝试一次，并将实际授权请求交给人审查。不要重复其他操作。", retry.id), approvalsReviewer: "user" });
  }
  async close(): Promise<void> { this.rpc.child.kill(); }
}
