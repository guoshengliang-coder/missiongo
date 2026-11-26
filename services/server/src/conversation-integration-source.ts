import { createHash } from "node:crypto";
import type { AgentKind } from "@missiongo/domain";
import { assertDispatchExecution, assertExternalExecution } from "./builder-authority.js";
import { conflict } from "./errors.js";
import type { MissionGoDatabase } from "./storage/database.js";
import type { FreeSessionConfig } from "./free-session-store.js";

export type IntegrationExecutor =
  | { kind: "dispatch"; dispatchId: string; sessionId: string; binding: string; settings: string }
  | { kind: "external"; sessionId: string; clientId: string; binding: string; settings: string };
export type ConversationIdentity = { dispatchId?: string; sessionId?: string };
export const integrationFingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unavailable = () => conflict("conversation_integration_source_missing", "缺少当前原生会话的可信身份或用户来源；请核实原节点同步，待集成是可选兼容入口。");

/** Resolve actual persisted identity/settings. No caller-selected node, model or permission mode. */
export function integrationExecutor(database: MissionGoDatabase, accountId: string, clientId: string,
  identity: ConversationIdentity, productId: string): { executor: IntegrationExecutor; config: FreeSessionConfig } {
  const db = database.connection;
  if (Boolean(identity.dispatchId) === Boolean(identity.sessionId)) throw unavailable();
  if (identity.dispatchId) {
    const row = db.prepare(`SELECT d.id,d.node_id,d.agent_kind,s.id AS session_id,s.agent_session_ref,
      s.settings_revision,s.applied_settings_revision,COALESCE(s.mode,d.mode) AS mode,COALESCE(s.model,d.model) AS model,COALESCE(s.effort,d.effort) AS effort FROM dispatches d JOIN agent_sessions s ON s.dispatch_id=d.id
      JOIN nodes n ON n.id=d.node_id WHERE d.id=? AND d.account_id=? AND n.account_id=?
      AND d.status='launched' AND d.archived_at IS NULL AND s.archived_at IS NULL AND s.source_archived_at IS NULL AND n.revoked_at IS NULL AND s.node_id=d.node_id
      AND (EXISTS(SELECT 1 FROM free_session_starts f WHERE f.dispatch_id=d.id AND f.product_id=?)
        OR EXISTS(SELECT 1 FROM dispatch_items i JOIN work_items w ON w.id=i.item_id WHERE i.dispatch_id=d.id AND w.product_id=?))`)
      .get(identity.dispatchId, accountId, accountId, productId, productId) as
      { id: string; node_id: string; agent_kind: AgentKind; session_id: string; agent_session_ref: string; settings_revision: number; applied_settings_revision:number; mode: string | null; model: string | null; effort: string | null } | undefined;
    if (!row || row.settings_revision!==row.applied_settings_revision || row.agent_session_ref.startsWith("pending:") || !["codex", "claude_code", "opencode"].includes(row.agent_kind)) throw unavailable();
    assertDispatchExecution(database, row.id);
    return { executor: { kind: "dispatch", dispatchId: row.id, sessionId: row.session_id, binding: integrationFingerprint([row.id,row.node_id,row.agent_kind,row.session_id,row.agent_session_ref]),settings:integrationFingerprint([row.settings_revision,row.mode,row.model,row.effort]) },
      config: { productId, nodeId: row.node_id, agentKind: row.agent_kind, mode: row.mode ?? "default",
        ...(row.model ? { model: row.model } : {}), ...(row.effort ? { effort: row.effort } : {}) } };
  }
  const row = db.prepare(`SELECT s.id,s.native_node_id,s.agent_kind,s.session_ref,s.native_generation,s.native_settings_json,s.native_snapshot_json
    FROM external_agent_sessions s JOIN nodes n ON n.id=s.native_node_id
    WHERE s.id=? AND s.account_id=? AND s.client_id=? AND n.account_id=? AND n.revoked_at IS NULL
      AND s.archived_at IS NULL AND s.ref_kind='native' AND s.native_synced_at IS NOT NULL
      AND (s.product_id=? OR EXISTS(SELECT 1 FROM external_agent_session_items i JOIN work_items w ON w.id=i.item_id WHERE i.session_id=s.id AND w.product_id=?))`)
    .get(identity.sessionId!, accountId, clientId, accountId, productId, productId) as
    { id: string; native_node_id: string; agent_kind: AgentKind; session_ref: string; native_generation: number; native_settings_json: string | null; native_snapshot_json:string|null } | undefined;
  if (!row || !["codex", "claude_code", "opencode"].includes(row.agent_kind) || !row.native_snapshot_json) throw unavailable();
  assertExternalExecution(database, row.id);
  const state = JSON.parse(row.native_settings_json??"{}") as {revision?:number;settled?:number};
  const snapshot=JSON.parse(row.native_snapshot_json) as {mode?:string;model?:string;effort?:string;sourceArchived?:boolean;status?:string};
  if(snapshot.sourceArchived || snapshot.status==="unavailable" || snapshot.status==="failed" || (state.revision??0)!==(state.settled??0))throw unavailable();
  const settings={mode:snapshot.mode,model:snapshot.model,effort:snapshot.effort};

  return { executor: { kind: "external", sessionId: row.id, clientId, binding: integrationFingerprint([row.id,row.native_node_id,row.agent_kind,row.session_ref,row.native_generation]),settings:integrationFingerprint([state.revision??0,settings]) },
    config: { productId, nodeId: row.native_node_id, agentKind: row.agent_kind, mode: settings.mode ?? "default",
      ...(settings.model ? { model: settings.model } : {}), ...(settings.effort ? { effort: settings.effort } : {}) } };
}

export interface IntegrationInstruction { sourceId: string; text: string; occurredAt: string; context: string; contextTrusted?: boolean; contextOccurredAt?: string; fingerprint: string }

/** Read only authenticated user records, not quotes supplied by the Agent or work-item content. */
export function integrationInstruction(database: MissionGoDatabase, executor: IntegrationExecutor, sourceId?: string, before?: string): IntegrationInstruction {
  const db = database.connection, external = executor.kind === "external", sessionId = executor.sessionId;
  const command = db.prepare(external
    ? "SELECT id,text,created_at,status FROM external_native_commands WHERE session_id=? AND (? IS NULL OR julianday(created_at)<julianday(?)) ORDER BY rowid DESC LIMIT 1"
    : "SELECT id,text,created_at,status FROM agent_session_commands WHERE session_id=? AND kind='message' AND (? IS NULL OR julianday(created_at)<julianday(?)) ORDER BY rowid DESC LIMIT 1")
    .get(sessionId, before ?? null, before ?? null) as { id: string; text: string; created_at: string; status: string } | undefined;
  const message = db.prepare(external
    ? `SELECT source_id,json_extract(payload_json,'$.text') AS text,json_extract(payload_json,'$.occurredAt') AS occurred_at,
        json_extract(payload_json,'$.clientMessageId') AS client_message_id FROM external_native_messages
       WHERE session_id=? AND json_extract(payload_json,'$.role')='user' AND COALESCE(json_extract(payload_json,'$.phase'),'')<>'execution' AND (? IS NULL OR julianday(json_extract(payload_json,'$.occurredAt')) IS NULL OR julianday(json_extract(payload_json,'$.occurredAt'))<julianday(?)) ORDER BY position DESC,rowid DESC LIMIT 1`
    : "SELECT source_id,text,occurred_at,client_message_id FROM agent_session_messages WHERE session_id=? AND role='user' AND COALESCE(phase,'')<>'execution' AND (? IS NULL OR julianday(occurred_at) IS NULL OR julianday(occurred_at)<julianday(?)) ORDER BY position DESC,rowid DESC LIMIT 1")
    .get(sessionId, before ?? null, before ?? null) as { source_id: string; text: string; occurred_at: string | null; client_message_id: string | null } | undefined;
  const clock = message ? db.prepare("SELECT occurred_at FROM session_message_times WHERE session_key=? AND source_id=? AND provenance='source_message'")
    .get(external ? `external:${sessionId}` : `dispatch:${executor.kind === "dispatch" ? executor.dispatchId : ""}`, `native:${message.source_id}`) as { occurred_at: string } | undefined : undefined;
  const sameCommand = command && message && (message.source_id === command.id || message.source_id === `answer-${command.id}` || message.client_message_id === command.id);
  // A native-only input must have its node-observed original clock. A newer queued or unknown input blocks execution.
  if (command && ["queued", "delivering", "delivery_unknown"].includes(command.status)) throw unavailable();
  let current: { sourceId: string; text: string; occurredAt: string };
  if (command && (sameCommand || !message || Date.parse(command.created_at) >= Date.parse(message.occurred_at ?? ""))) {
    if (command.status !== "delivered" || sameCommand && message!.text !== command.text) throw unavailable();
    current = { sourceId: `command:${command.id}`, text: command.text, occurredAt: command.created_at };
  } else {
    if (!message || !clock || !message.occurred_at || Date.parse(clock.occurred_at) !== Date.parse(message.occurred_at)) throw unavailable();
    current = { sourceId: `native:${message.source_id}`, text: message.text, occurredAt: message.occurred_at };
  }
  if(!external && db.prepare("SELECT 1 FROM agent_session_commands WHERE session_id=? AND kind='interrupt' AND status NOT IN ('failed','cancelled') AND julianday(created_at)>=julianday(?)").get(sessionId,current.occurredAt))throw unavailable();
  if (sourceId && sourceId !== current.sourceId) throw conflict("conversation_integration_input_changed", "当前用户输入已变化，请核对原会话指令，不重建或重复执行未知操作。");
  const contextRow = db.prepare(external
    ? `SELECT source_id,json_extract(payload_json,'$.text') AS text,json_extract(payload_json,'$.occurredAt') AS at FROM external_native_messages WHERE session_id=? AND json_extract(payload_json,'$.role')='agent'
       AND json_extract(payload_json,'$.phase')='final_answer' AND julianday(json_extract(payload_json,'$.occurredAt'))<julianday(?) ORDER BY position DESC,rowid DESC LIMIT 1`
    : "SELECT source_id,text,occurred_at AS at FROM agent_session_messages WHERE session_id=? AND role='agent' AND phase='final_answer' AND julianday(occurred_at)<julianday(?) ORDER BY position DESC,rowid DESC LIMIT 1")
    .get(sessionId, current.occurredAt) as { source_id: string; text: string; at: string } | undefined;
  const context = contextRow?.text ?? "";
  const contextClock = contextRow ? db.prepare("SELECT occurred_at FROM session_message_times WHERE session_key=? AND source_id=? AND provenance='source_message'")
    .get(external ? `external:${sessionId}` : `dispatch:${executor.kind === "dispatch" ? executor.dispatchId : ""}`, `native:${contextRow.source_id}`) as { occurred_at: string } | undefined : undefined;
  const contextTrusted = Boolean(contextRow && contextClock && Date.parse(contextRow.at) === Date.parse(contextClock.occurred_at));
  return { ...current, context, contextTrusted, ...(contextTrusted && contextRow ? {contextOccurredAt:contextRow.at} : {}), fingerprint: integrationFingerprint([current, context]) };
}

const wholeScopeCommand = /^(?:全部|一起)(?=(?:合并(?:和|并|及|、)(?:发布|部署)|合并|发布|部署)[。.!！]?\s*$)/;
export const isWholeScopeIntegrationCommand = (text: string) => /^[\s,，;；]*(?:全部|一起)(?=合并|发布|部署)/.test(text);

/** Conservative rejection filter, never an automatic execution trigger. Agent still resolves scope and meaning. */
export function assertIntegrationInstruction(text: string, operation: "merge_only" | "merge_and_publish" | "publish_only") {
  // An explicit exclusion narrows this action; it must never authorize the excluded operation.
  const raw=text;
  if(operation==="merge_only")text=text.replace(/(?:暂不|先不|不要|不用|无需|不)(?:进行)?(?:发布|部署)/g,"").replace(/\b(?:do not|don't|not) (?:publish|release|deploy)\b/ig,"");
  if(operation==="publish_only")text=text.replace(/(?:暂不|先不|不要|不用|无需|不)(?:进行)?合并/g,"").replace(/\b(?:do not|don't|not) merge\b/ig,"");
  // Only a removed exclusion can leave a trailing separator; do not strip narrative clauses.
  if (text !== raw) text=text.replace(/[\s,，;；]+([。.!！]?)$/, "$1");
  text=text.replace(/^[\s,，;；]+/,"");
  text=text.replace(wholeScopeCommand,"");
  if (!text.trim() || raw.length > 4000 || /[?？“”「」『』"`]|(?:不|别|勿|禁止|停止|暂停|暂缓|取消|以后|明天|后天|如果|假如|等我|(?:等|待).*(?:后|再|通过|完成|结束|确认|批准)|(?:通过|完成|结束|确认|批准)(?:之|以)?(?:后|再)|是否|能否|为什么|怎么|吗|么|添加|加入|提交到|方案|建议|准备|计划|引用|文档里|文档中|例如)|\b(?:not|don't|do not|can't|cannot|if|when|once|after|later|tomorrow|why|whether|queue|plan|prepare)\b/i.test(text))
    throw conflict("conversation_integration_instruction_ambiguous", "这条消息不是范围明确的当前执行指令，请先澄清；不能把讨论或加入清单当作合并发布授权。");
  // Continue is a new execution entry: accept a complete imperative, not arbitrary trailing narration.
  const continuing = /^(?:请)?继续/.test(text.trim());
  if (continuing && !/^(?:请)?继续(?:执行)?(?:合并(?:(?:和|并|及|、)(?:发布|部署))?|发布|部署)(?:\s*(?:PR\s*#?\d+|#\d+))?[。.!！]?$/i.test(text.trim()))
    throw conflict("conversation_integration_instruction_ambiguous", "继续执行须给出明确动作，不能把附带汇报或条件当作当前执行指令。");
  if(!/^(?:请|现在|直接|立即|继续(?:执行)?(?=合并|发布|部署)|执行|开始|帮我|麻烦|把|将|仅|只|合并|发布|部署|only\b|merge\b|publish\b|deploy\b|release\b|please\b|go ahead\b)/i.test(text.trim()) || /(?:已经|已)(?:合并|发布|部署)|(?:合并|发布|部署)(?:已经?|已然)?(?:成功|完成|结束)/.test(text))
    throw conflict("conversation_integration_instruction_ambiguous", "不能把完成汇报或引用当作当前执行指令。");
  const merge = /合并|\bmerge\b/i.test(text), publish = /发布|部署|\b(?:publish|release|deploy)\b/i.test(text);
  if (merge !== (operation !== "publish_only") || publish !== (operation !== "merge_only"))
    throw conflict("conversation_integration_operation_mismatch", "指令与仅合并／仅发布／合并并发布动作不一致，不能扩大授权。");
}

export const isIntegrationStop = (text: string) => /^(?:请)?(?:先)?(?:停止|暂停|取消|撤销)(?:执行|操作|合并|发布|合并并发布|合并和发布)?[。.!！]?$|^(?:please )?(?:stop|cancel|pause)(?: (?:merge|publish|execution))?[.!]?$/i.test(text.trim());

/** A short command may not reauthorize a previously stopped operation. */
export function hasIntegrationStop(database: MissionGoDatabase, executor: IntegrationExecutor) {
  const db = database.connection;
  const external = executor.kind === "external";
  if (!external && db.prepare("SELECT 1 FROM agent_session_commands WHERE session_id=? AND kind='interrupt' AND status NOT IN ('failed','cancelled') LIMIT 1").get(executor.sessionId)) return true;
  const rows = db.prepare(external
    ? `SELECT text FROM external_native_commands WHERE session_id=?1 AND status NOT IN ('failed','cancelled')
       UNION ALL SELECT json_extract(payload_json,'$.text') FROM external_native_messages
       WHERE session_id=?1 AND json_extract(payload_json,'$.role')='user' AND COALESCE(json_extract(payload_json,'$.phase'),'')<>'execution'`
    : `SELECT text FROM agent_session_commands WHERE session_id=?1 AND kind='message' AND status NOT IN ('failed','cancelled')
       UNION ALL SELECT text FROM agent_session_messages WHERE session_id=?1 AND role='user' AND COALESCE(phase,'')<>'execution'`)
    .all({ "1": executor.sessionId }) as { text: string | null }[];
  return rows.some(row => isIntegrationStop(row.text ?? ""));
}

export const isIntegrationStatus = (text: string) =>
  /^(?:请)?(?:进度(?:如何|怎么样)?|查看进度|当前状态|状态如何|(?:现在)?(?:合并|发布)(?:进度|状态)(?:如何|怎么样)?|(?:现在)?(?:合并|发布)了吗|(?:还有)?多久(?:能|可以)?(?:合并|发布)|能否(?:合并|发布|合并和发布|合并并发布)|可以(?:合并|发布|合并和发布|合并并发布)吗|status)[。.!！?？]?$/i.test(text.trim());

export function isDirectIntegrationAction(text: string, operation: "merge_only" | "merge_and_publish" | "publish_only") {
  const command = text.trim().replace(/^(?:请|直接|现在|执行|开始)+/, "").replace(/[。.!！]$/, "").trim();
  if (operation === "merge_only") return /^(?:仅|只)?合并$/.test(command) || /^(?:please )?merge$/i.test(command);
  if (operation === "publish_only") return /^(?:仅|只)?(?:发布|部署)$/.test(command) || /^(?:please )?(?:publish|deploy)$/i.test(command);
  return /^合并(?:和|并|及|、)(?:发布|部署)$/.test(command) || /^(?:please )?merge and (?:publish|deploy)$/i.test(command);
}

/** The remainder can execute only after the exact previously saved delivery is ready. */
export function deferredIntegrationAction(text: string): string | undefined {
  return /^(?:(?:先(?:实施|修复|修改|开发|执行)|(?:那)?按(?:你(?:的)?)?(?:最新|当前|已定)?方案(?:执行迭代|实施|执行))[，,、\s]*)?(?:完成|做完|改完)后[，,\s]*(合并(?:和|并|及)(?:发布|部署)|合并)[。.!！]?$/i.exec(text.trim())?.[1];
}

export const isIntegrationContinue = (text: string) => /^(?:请)?(?:继续(?:执行|处理)?|continue)[。.!！]?$/i.test(text.trim());

export const isIntegrationRetry = (text: string) => /^(?:请|你)?(?:(?:再试|重新试|重试)(?:一?下|一次)?|retry)[。.!！]?$/i.test(text.trim());

/** Later chat cannot enlarge the operation already frozen in the batch. */
export function permitsBoundIntegrationInput(text: string, allowRepair: boolean) {
  if (isIntegrationStatus(text) || isIntegrationRetry(text) || isIntegrationContinue(text)) return true;
  if (/(?:停|撤|取消|搁置|终止|中止|作废|到此为止|结束本次|结束批次|别|勿|禁止|暂停|暂缓|延后|推迟|稍后|缓[一缓]|缓缓|等下|等等|等我|等通知|等.+(?:再|才|之后|通过|完成|确认|批准)|待.+(?:再|才|之后|通过|完成|确认|批准)|如果|假如|除非|(?:验收|审核|审批|确认|批准)(?:通过|完成)?(?:之后|以后|后|再|才)|暂不|先不|不再|不用|不要|不许|不必|无需|无须|没必要|不(?:想|打算|需要)?(?:修复|补修|修好|继续|处理)|返工|重做|改成|改为|换(?:个|一|到|掉)|改用|范围|另开|另起|另外|顺带|顺便|升级|重构|增加|加上|扩大|缩小|仅|只|\b(?:stop|pause|hold|cancel|revoke|wait|switch|instead|only|except|scope|rework|not|don't|redo|if|unless|after|until)\b)/i.test(text))
    return false;
  if (/^(?:好|好的|收到|明白|了解|谢谢|ok|thanks)[。.!！]?$/i.test(text.trim())) return true;
  if (/(?:进度如何|进展怎么样|状态如何|还要多久)[?？。]?\s*$|(?:进度|进展|状态)[?？]\s*$|(?:接下来|什么时候|多久|status|progress).*?[?？]\s*$/i.test(text)) {
    return !/修改|更换|重来|改变|change|replace/i.test(text)
      && !/(?:^|[，。；,;])\s*(?:请|直接|现在|立即)?\s*(?:合并|发布|部署|推送|merge|publish|deploy|push)(?!\s*(?:进度|状态|了|status|progress))/i.test(text);
  }

  if (/(?:#\s*\d+|\/(?:pull|commit)\/|\b[a-f0-9]{7,40}\b|\b\d+\.\d+\.\d+\b)/i.test(text)) return false;

  // The batch already grants necessary repairs to its exact delivery.
  if (!allowRepair || !/修复|补修|修好|\brepair\b|\bfix\b/i.test(text)
      || !/授权|同意|可以|请|(?:你)?去|\b(?:go ahead|please|authorized?|allow)\b/i.test(text)) return false;
  const repairText = text.replace(/(?:直到|直至|然后|并)\s*(?:完成)?(?:合并(?:和|并|及|、)?(?:发布|部署)?|发布|部署)(?:完成)?[。.!！]?\s*$/i, "");
  return !/合并|发布|部署|推送|\b(?:merge|publish|deploy|release|push)\b/i.test(repairText);
}

export function integrationConsentReply(text: string) {
  const reply = text.trim().replace(/[。.!！‘’]$/, "");
  return /^(?:同意|批准|授权|确认|可以执行|同意执行|确认执行)$/.test(reply) ? reply : undefined;
}
export const isIntegrationConsent = (text: string) => Boolean(integrationConsentReply(text));

export function distinctConversationInputs<Clock extends string | null>(
  commands: Array<{ id: string; status: string; text: string; at: Clock }>,
  messages: Array<{ source_id: string; client_message_id: string | null; text: string; at: Clock }>,
): Array<{ text: string; at: Clock }> {
  const delivered = commands.filter(command => command.status === "delivered");
  const commandsById = new Map(delivered.map(command => [command.id, command]));
  const nativeOnly = messages.filter(message => {
    const commandId = message.client_message_id ?? message.source_id.replace(/^answer-/, "");
    return commandsById.get(commandId)?.text !== message.text;
  });
  return [...delivered, ...nativeOnly];
}

/** Check the inclusive interval so two records with the same clock cannot hide a stop. */
export function assertConversationRetryHistory(database: MissionGoDatabase, executor: IntegrationExecutor,
  authorization: IntegrationInstruction, retry: IntegrationInstruction, allowStatus = false, allowEndpoint = false,
  boundInput?: (text: string) => boolean, interruptAfter?: string) {
  const external = executor.kind === "external";
  const db = database.connection;
  const args = [executor.sessionId, authorization.occurredAt, retry.occurredAt] as const;
  if (!external && db.prepare(`SELECT 1 FROM agent_session_commands WHERE session_id=? AND kind='interrupt'
    AND status NOT IN ('failed','cancelled')
    AND (julianday(created_at) BETWEEN julianday(?) AND julianday(?) OR julianday(created_at) IS NULL)`).get(executor.sessionId,interruptAfter ?? authorization.occurredAt,retry.occurredAt))
    throw conflict("conversation_integration_stopped", "原决定之后收到停止指令，请先核实执行状态。");
  const commands = db.prepare(external
    ? "SELECT id,text,created_at AS at,status FROM external_native_commands WHERE session_id=? AND (julianday(created_at) BETWEEN julianday(?) AND julianday(?) OR julianday(created_at) IS NULL)"
    : "SELECT id,text,created_at AS at,status FROM agent_session_commands WHERE session_id=? AND kind='message' AND (julianday(created_at) BETWEEN julianday(?) AND julianday(?) OR julianday(created_at) IS NULL)")
    .all(...args) as { id: string; text: string; at: string; status: string }[];
  const messages = db.prepare(external
    ? `SELECT source_id,json_extract(payload_json,'$.text') AS text,json_extract(payload_json,'$.occurredAt') AS at,
       json_extract(payload_json,'$.clientMessageId') AS client_message_id
       FROM external_native_messages WHERE session_id=? AND json_extract(payload_json,'$.role')='user'
       AND COALESCE(json_extract(payload_json,'$.phase'),'')<>'execution'
       AND (julianday(json_extract(payload_json,'$.occurredAt')) BETWEEN julianday(?) AND julianday(?) OR julianday(json_extract(payload_json,'$.occurredAt')) IS NULL)`
    : `SELECT source_id,text,occurred_at AS at,client_message_id FROM agent_session_messages WHERE session_id=? AND role='user'
       AND COALESCE(phase,'')<>'execution' AND (julianday(occurred_at) BETWEEN julianday(?) AND julianday(?) OR julianday(occurred_at) IS NULL)`)
    .all(...args) as { source_id: string; text: string; at: string; client_message_id: string | null }[];
  const key = external ? `external:${executor.sessionId}` : `dispatch:${executor.dispatchId}`;
  const clock = db.prepare("SELECT occurred_at FROM session_message_times WHERE session_key=? AND source_id=? AND provenance='source_message'");
  if (commands.some(command => !["delivered", "failed", "cancelled"].includes(command.status)) || messages.some(message => {
    const record = clock.get(key, `native:${message.source_id}`) as { occurred_at: string } | undefined;
    return !record || Date.parse(record.occurred_at) !== Date.parse(message.at);
  })) throw conflict("conversation_integration_history_incomplete", "重试区间的可信输入历史不完整。");
  if (boundInput) {
    const original = authorization.sourceId.startsWith("command:")
      ? commands.find(command => command.id === authorization.sourceId.slice(8) && command.status === "delivered")
      : messages.find(message => message.source_id === authorization.sourceId.slice(7));
    if (!original || original.text !== authorization.text || Date.parse(original.at) !== Date.parse(authorization.occurredAt))
      throw conflict("conversation_integration_history_incomplete", "原批次的可信输入历史缺失。");
  }
  const authorizedAt = Date.parse(authorization.occurredAt);
  // A trusted native mirror can have a different clock from the delivered command.
  if (distinctConversationInputs(commands, messages).some(input => {
    const at = Date.parse(input.at);
    return !(input.text === authorization.text && at === authorizedAt
      || at > authorizedAt && allowEndpoint && at === Date.parse(retry.occurredAt) && input.text === retry.text
      || at >= authorizedAt && (boundInput ? boundInput(input.text)
        : at > authorizedAt && (isIntegrationRetry(input.text) || isIntegrationContinue(input.text) || allowStatus && isIntegrationStatus(input.text))));
  })) throw conflict("conversation_integration_input_changed", "原决定之后有不同输入，请核对停止、撤权或范围变化。");
}
