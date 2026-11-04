import { readFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { labelledAnswers } from "./claude.js";
import type { Adapter, Command, Dispatch, Message, Question, Session, Snapshot, Wire } from "./types.js";
import { id, object } from "./types.js";

class OpenCodeHTTPError extends Error {
  constructor(readonly status: number, readonly validation: boolean) { super(`OpenCode HTTP ${status}`); }
}

export class OpenCodeAPI {
  constructor(private registrationPath = join(homedir(), ".local/state/opencode/service.json")) {}
  async call(method: string, path: string, body?: unknown): Promise<Wire> {
    const stat = lstatSync(this.registrationPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error("Invalid OpenCode service registration owner");
    const registration = object(JSON.parse(readFileSync(this.registrationPath, "utf8")));
    const url = new URL(registration.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !registration.password
      || Number(String(registration.version).split(".")[0]) < 2) throw new Error("Start the registered OpenCode 2 shared service first");
    const response = await fetch(new URL(path, url.origin), { method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString("base64")}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { message?: string };
      throw new OpenCodeHTTPError(response.status, response.status === 400 && String(detail.message).includes('["prompt"]'));
    }
    return response.status === 204 ? {} : object(await response.json());
  }
}
export function openCodeMessages(entries: Wire[]): Message[] {
  return entries.flatMap((entry): Message[] => {
    const text = entry.type === "user" ? entry.text : (entry.content ?? []).filter((part: Wire) => part.type === "text").map((part: Wire) => part.text).join("\n\n");
    if (!entry.id || typeof text !== "string" || !text.trim() || !["user", "assistant"].includes(entry.type)) return [];
    return [{ sourceId: entry.id, role: entry.type === "user" ? "user" : entry.agent === "plan" ? "plan" : "agent", text }];
  });
}
export class OpenCodeAdapter implements Adapter {
  private ref = "";
  initialTurnId?: string;
  private path = "";
  constructor(private job: Dispatch, readonly api = new OpenCodeAPI()) {}
  async start(prompt: string): Promise<string> {
    const info = await this.api.call("GET", "/api/info");
    if (!(Number(String(info.version).split(".")[0]) >= 2)) throw new Error("OpenCode 2 is required");
    const mcp = await this.api.call("GET", `/api/mcp?${new URLSearchParams({ "location[directory]": this.job.repoPath })}`);
    if (!Array.isArray(mcp.data) || mcp.data.find((server: Wire) => server.name === "missiongo")?.status?.status !== "connected") {
      throw new Error("Authorize missiongo MCP in this OpenCode service and repository");
    }
    const result = await this.api.call("POST", "/api/session", { agent: this.job.mode === "plan" ? "plan" : "build", location: { directory: this.job.repoPath },
      ...(this.job.model ? { model: modelRef(this.job.model, this.job.effort) } : {}) });
    this.ref = id(result.data?.id); this.path = `/api/session/${encodeURIComponent(this.ref)}`;
    const title = `${this.job.nodeName ?? "Linux"}-${this.job.itemKeys.join(",")}`;
    try { await this.api.call("PATCH", this.path, { title }); }
    catch (error) { if (!(error instanceof OpenCodeHTTPError) || error.status !== 404) throw error; await this.api.call("POST", `${this.path}/rename`, { title }); }
    await this.prompt(prompt);
    this.initialTurnId = (await this.api.call("GET", `${this.path}/message?limit=1&order=asc`)
      .catch(() => ({} as Wire))).data?.find((entry: Wire) => entry.type === "user")?.id;
    return this.ref;
  }
  private async choices(): Promise<{ forms: Wire[]; permissions: Wire[] }> {
    const optional = async (path: string) => {
      try { return (await this.api.call("GET", path)).data ?? []; }
      catch (error) { if ((error as Error).message === "OpenCode HTTP 404") return []; throw error; }
    };
    return { forms: await optional(`${this.path}/form`), permissions: await optional(`${this.path}/permission`) };
  }
  private async prompt(text: string): Promise<void> {
    try { await this.api.call("POST", `${this.path}/prompt`, { text, delivery: "queue" }); }
    catch (error) {
      // Only an explicit schema rejection proves that the first form was not accepted.
      if (!(error instanceof OpenCodeHTTPError) || !error.validation) throw error;
      await this.api.call("POST", `${this.path}/prompt`, { prompt: { text }, delivery: "queue" });
    }
  }
  async snapshot(): Promise<Snapshot> {
    const details = await this.api.call("GET", this.path);
    const messages: Message[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 30; page++) {
      const query = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : { order: "asc" }) });
      const result = await this.api.call("GET", `${this.path}/message?${query}`);
      messages.push(...openCodeMessages(result.data ?? []));
      const next = result.nextCursor ?? result.cursor?.next;
      if (!next || next === cursor) { cursor = undefined; break; } cursor = next;
    }
    const choices = await this.choices();
    for (const p of choices.permissions) messages.push({ sourceId: `permission-${p.id}`, role: "agent", text: p.message || `OpenCode 请求使用 ${p.action}`,
      questions: [{ title: `OpenCode 请求使用 ${p.action}`, key: `授权请求 ${p.id}`, options: ["允许一次", "拒绝"], detail: JSON.stringify(p.resources ?? []).slice(0, 4000) }] });
    for (const form of choices.forms) {
      const questions: Question[] = (form.fields ?? []).filter((f: Wire) => !f.hidden).map((f: Wire) => ({ title: f.title || f.key, key: f.key,
        ...(f.description ? { detail: f.description } : {}), ...(f.options?.length ? { options: f.options.map((o: Wire) => o.label || o.value) } : { kind: ["number", "integer"].includes(f.type) ? "number" : f.type === "boolean" ? "boolean" : "text" }),
        multiSelect: f.type === "multiselect", custom: f.custom === true }));
      if (questions.length) messages.push({ sourceId: `form-${form.id}`, role: "agent", text: form.title || "OpenCode 请求确认", questions });
    }
    const active = await this.api.call("GET", "/api/session/active");
    const running = active.data?.[this.ref] !== undefined;
    return { status: details.data?.outcome === "failed" ? "failed" : running ? "active" : "idle", messages: messages.slice(-2000),
      turnActive: running, waitingForInput: choices.permissions.length + choices.forms.length > 0,
      ...(cursor ? { error: "OpenCode message pagination exceeded the 3000-message limit" } : {}) };
  }
  private async stopState(): Promise<{ active: boolean; input?: string }> {
    const active = (await this.api.call("GET", "/api/session/active")).data?.[this.ref] !== undefined;
    if (!active) return { active: false };
    const tail = await this.api.call("GET", `${this.path}/message?limit=100&order=desc`);
    return { active: true, input: tail.data?.find((entry: Wire) => entry.type === "user")?.id };
  }
  async stop(command: Command): Promise<Snapshot> {
    const target = command.turnId === "startup" ? this.initialTurnId : command.turnId;
    const before = await this.stopState();
    if (!before.active) return { status: "idle", messages: [], turnActive: false };
    if (!target || target !== before.input) throw new Error("停止未发送：原回合已变化或无法确认");
    const checked = await this.stopState();
    if (!checked.active) return { status: "idle", messages: [], turnActive: false };
    if (checked.input !== target) throw new Error("停止未发送：原回合已变化");
    let failure: unknown;
    try { await this.api.call("POST", `${this.path}/interrupt`); } catch (error) { failure = error; }
    const after = await this.stopState();
    if (!after.active) return { status: "idle", messages: [], turnActive: false };
    throw new Error(`停止尚未确认：${failure instanceof Error ? failure.message : "来源仍在运行"}`);
  }
  async deliver(command: Command): Promise<void> {
    if (command.kind === "interrupt") { await this.stop(command); return; }
    const choices = await this.choices();
    const permission = choices.permissions[0];
    if (permission) {
      const key = `授权请求 ${permission.id}: `;
      if (!command.text.startsWith(key)) throw new Error("Answer the displayed permission request by its exact key");
      const answer = command.text.slice(key.length).trim();
      const decision = answer === "允许一次" ? "once" : answer === "拒绝" ? "reject" : undefined;
      if (!decision) throw new Error("Unsupported permission answer");
      await this.api.call("POST", `${this.path}/permission/${encodeURIComponent(permission.id)}/reply`, { decision });
      return;
    }
    const form = choices.forms[0];
    if (form) {
      const labels = labelledAnswers(command.text); const answer: Wire = {};
      for (const field of (form.fields ?? []).filter((f: Wire) => !f.hidden)) {
        const raw = labels[field.key] ?? labels[field.title] ?? (form.fields.length === 1 ? command.text : undefined);
        if (raw === undefined) { if (field.required) throw new Error("Answer all required form fields"); continue; }
        const value = (label: string) => {
          const option = field.options?.find((o: Wire) => (o.label || o.value) === label);
          if (field.options?.length && !option && !field.custom) throw new Error("Unsupported form option");
          return option?.value ?? label;
        };
        answer[field.key] = field.type === "multiselect" ? raw.split(/[、,]/).map((s) => value(s.trim()))
          : ["number", "integer"].includes(field.type) ? Number(raw) : field.type === "boolean" ? raw === "true" : value(raw);
        if (typeof answer[field.key] === "number" && !Number.isFinite(answer[field.key])) throw new Error("Invalid numeric form answer");
      }
      await this.api.call("POST", `${this.path}/form/${encodeURIComponent(form.id)}/reply`, { answer }); return;
    }
    const previous = new Set((await this.snapshot()).messages.map((message) => message.sourceId));
    await this.prompt(command.text);
    for (let attempt = 0; attempt < 10; attempt++) {
      if ((await this.snapshot()).messages.some((m) => !previous.has(m.sourceId) && m.role === "user" && m.text === command.text)) return;
      await delay(500);
    }
    throw new Error("OpenCode delivery is unconfirmed; do not resend automatically");
  }
  async decide(): Promise<void> { throw new Error("Answer the displayed OpenCode permission question"); }
  async settings(settings: NonNullable<Session["desiredSettings"]>): Promise<void> {
    if (settings.mode && !["plan", "default"].includes(settings.mode)) throw new Error("Unsupported OpenCode mode");
    if (settings.mode) await this.api.call("POST", `${this.path}/agent`, { agent: settings.mode === "plan" ? "plan" : "build" });
    if (settings.model) await this.api.call("POST", `${this.path}/model`, { model: modelRef(settings.model, settings.effort) });
  }
  async close(): Promise<void> { /* The shared service and source conversation belong to the user. */ }
}
function modelRef(model: string, effort?: string): Wire {
  const separator = model.indexOf("/");
  if (separator < 1 || separator === model.length - 1) throw new Error("OpenCode model must be provider/model");
  return { providerID: model.slice(0, separator), id: model.slice(separator + 1), ...(effort ? { variant: effort } : {}) };
}
