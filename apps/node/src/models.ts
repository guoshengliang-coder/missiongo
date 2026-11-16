import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { JsonProcess } from "./process.js";
import { OpenCodeAPI } from "./opencode.js";
import type { AgentConfig, Kind, Wire } from "./types.js";
import type { ClaudeLaunch } from "./environment.js";

export interface AgentModel { id: string; label: string; provider?: string; efforts: string[]; defaultEffort?: string; isDefault?: boolean }
export function modelOptions(kind: Kind, value: Wire): AgentModel[] {
  const entries: Wire[] = kind === "claude_code" ? value.models ?? [] : value.data ?? [];
  if (!Array.isArray(entries)) return [];
  const result = new Map<string, AgentModel>();
  for (const entry of entries.slice(0,1000)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (entry.hidden || (kind === "opencode" && !entry.capabilities?.tools)) continue;
    const model = kind === "claude_code" ? entry.value : kind === "opencode" ? entry.modelID ?? entry.id : entry.model ?? entry.id;
    if (typeof model !== "string" || !model || model === "default") continue;
    const provider = kind === "opencode" ? entry.providerID : undefined;
    if (kind === "opencode" && (typeof provider !== "string" || !provider || provider.startsWith("-"))) continue;
    const id = provider ? `${provider}/${model}` : model;
    if (id.length > 200) continue;
    const label = String(entry.displayName ?? entry.name ?? model).slice(0, 200);
    const catalog = kind === "claude_code" ? entry.supportedEffortLevels : kind === "opencode" ? entry.variants : entry.supportedReasoningEfforts;
    const rawEfforts: unknown[] = !Array.isArray(catalog) ? [] : kind === "claude_code" ? catalog
      : catalog.map((value: Wire) => value && typeof value === "object" ? kind === "opencode" ? value.id : value.reasoningEffort : undefined);
    const efforts = [...new Set<string>(rawEfforts.filter((effort: unknown): effort is string => typeof effort === "string" && effort.length > 0 && effort.length <= 200))].slice(0, 20);
    const previous = result.get(id);
    result.set(id, { id, label, efforts: [...new Set([...(previous?.efforts ?? []), ...efforts])].slice(0, 20),
      ...(provider ? { provider } : {}), ...(typeof entry.defaultReasoningEffort === "string" && efforts.includes(entry.defaultReasoningEffort) ? { defaultEffort: entry.defaultReasoningEffort } : {}), ...(entry.isDefault === true ? { isDefault: true } : {}) });
    if (result.size >= 100) break;
  }
  return [...result.values()];
}

const cache = new Map<string, { at: number; models: Promise<AgentModel[]> }>();
/** Configuration paths alone do not identify the environment a launcher uses.
 * Keep only a digest: provider credentials must not become cache-key text. */
export function agentProbeKey(kind: Kind, settings: AgentConfig, launch: ClaudeLaunch): string {
  return createHash("sha256").update(JSON.stringify([kind, settings, launch.executable,
    Object.entries(launch.env).filter(([,value])=>value !== undefined).sort(([a],[b])=>a.localeCompare(b))])).digest("hex");
}
/** Read-only local metadata. Never sends a user message, runs hooks or asks a model. */
export function availableModels(kind: Kind, settings: AgentConfig, launch: ClaudeLaunch): Promise<AgentModel[]> {
  const key = agentProbeKey(kind, settings, launch); const previous = cache.get(key);
  if (previous && Date.now() - previous.at < 10 * 60_000) return previous.models;
  const models = (async () => {
    if (kind === "opencode") {
      const api = new OpenCodeAPI(settings.serviceRegistration, launch.env);
      const info = await api.call("GET", "/api/info");
      if (!(Number(String(info.version).split(".")[0]) >= 2)) throw new Error("OpenCode 2 is required");
      return api.call("GET", "/api/model").then((value) => modelOptions(kind, value)).catch(() => []);
    }
    const rpc = new JsonProcess(launch.executable, kind === "codex" ? ["app-server"] : ["--safe-mode", "--strict-mcp-config", "--no-chrome", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--permission-mode", "plan", "--session-id", randomUUID()],
      (process.platform === "win32" ? launch.env.USERPROFILE : launch.env.HOME) ?? homedir(), launch.env);
    const deadline=setTimeout(()=>rpc.close(),20_000);
    try {
      if (kind === "codex") {
        const identity = await rpc.call("initialize", { clientInfo: { name: "missiongo_model_check", version: "1" }, capabilities: { experimentalApi: true } }, 10_000);
        if (typeof identity.userAgent !== "string" || !/codex/i.test(identity.userAgent)) throw new Error("Codex app-server identity was not recognized");
        rpc.write({ method: "initialized" });
        try {
          const result: AgentModel[] = []; let cursor: string | undefined;
          const seen = new Set<string>(); let pages=0;
          do {
            if (++pages > 10) throw new Error("Model catalog page limit exceeded");
            const page = await rpc.call("model/list", { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) }, 10_000);
            result.push(...modelOptions(kind, page));
            if (page.nextCursor !== undefined && page.nextCursor !== null && (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor.length > 4096)) throw new Error("Invalid model cursor");
            cursor = page.nextCursor;
            if (cursor && seen.has(cursor)) throw new Error("Repeated model cursor"); if (cursor) seen.add(cursor);
          } while (cursor && result.length < 100);
          return result.slice(0, 100);
        } catch { return []; } // Catalog failure does not invalidate a successful control handshake.
      }
      return await new Promise<AgentModel[]>((resolve, reject) => {
        const id = randomUUID(); const timer = setTimeout(() => reject(new Error("Model metadata timed out")), 10_000);
        rpc.onClose = () => { clearTimeout(timer); reject(new Error("Model metadata channel closed")); };
        rpc.onEvent = (event) => {
          if (event.type !== "control_response" || event.response?.request_id !== id) return;
          clearTimeout(timer);
          if (event.response.subtype !== "success") reject(new Error("Claude control initialization failed"));
          else {
            try { resolve(modelOptions(kind, event.response.response ?? {})); }
            catch { resolve([]); } // A malformed catalog cannot strand an initialized control channel.
          }
        };
        rpc.write({ type: "control_request", request_id: id, request: { subtype: "initialize" } });
      });
    } finally { clearTimeout(deadline); rpc.close(); }
  })();
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), models }); return models;
}
