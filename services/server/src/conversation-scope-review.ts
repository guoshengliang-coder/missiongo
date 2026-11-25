import { publicationActionBounds, scopeConflict, type ConversationPublicationBounds } from "./conversation-publication-targets.js";
import type { MissionGoDatabase } from "./storage/database.js";
import { conflict } from "./errors.js";
import { assertIntegrationInstruction, distinctConversationInputs, integrationFingerprint, isIntegrationRetry, isIntegrationContinue, isIntegrationStatus, type IntegrationExecutor, type IntegrationInstruction } from "./conversation-integration-source.js";

export interface ConversationReviewEvidence {
  sourceId: string; occurredAt: string; textDigest: string; reviewDigest: string;
  executorBinding: string; settings: string; instructionSourceId: string;
}
const missing = () => conflict("conversation_integration_history_incomplete", "范围审阅来源或中间输入不完整，请核对原会话历史，不自动复用旧决定。");
const changed = () => conflict("conversation_integration_scope_review_required", "范围审阅后出现停止、范围变化或歧义，请核对当前范围与决定，不自动复用旧决定。");

/** Match the disclosed scope across harmless Markdown and line-wrap changes. */
export function containsConversationScope(text: string, reviewText: string, wholeMessage = false) {
  const normalize = (value: string) => value.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n+/g, "\n").trim();
  const withoutConfiguration = (value: string) => value.replace(/\n执行配置 \{[^\n]*\}；仅记录原会话实际配置，不创建新会话、不改变模型或原生权限。\s*$/, "");
  const scope = normalize(withoutConfiguration(reviewText));
  const matches = wholeMessage ? normalize(withoutConfiguration(text)) === scope : normalize(text).includes(scope);
  return matches
    && (text.match(/原会话执行范围：/g)?.length ?? 0) === 1;
}

/** The latest *scope-bearing* final answer is a review, not an execution grant.
 * Ordinary progress cannot hide it; a newer different scope cannot be skipped.
 * Read only this authenticated executor's persisted node messages. */
export function conversationScopeReview(database: MissionGoDatabase, executor: IntegrationExecutor,
  instruction: IntegrationInstruction, reviewText: string, reviewDigest: string,
  operation: "merge_only" | "merge_and_publish" | "publish_only",
  references: readonly {repository:string;pullRequest:number;head:string}[],
  reviewedDecision=false, publicationBounds:ConversationPublicationBounds={requiredArtifacts:[],declaredArtifacts:[]}, retry?:IntegrationInstruction): ConversationReviewEvidence | undefined {
  const assertActionBounds=(text:string,decision=false)=>{
    // This is a server-derived fact from the immediately preceding unique
    // complete review, never an MCP argument or an Agent-provided approval.
    if (!decision) {
      // Reject scope qualifications instead of counting excluded references as
      // positive authorization. An operation-only "only merge/publish" remains valid.
      const scopeText=text.replace(/https?:\/\/[^\s<>，。；]+/ig," ")
        .replace(/^(?:请)?(?:仅|只)(?=合并|发布|部署)/,"")
        .replace(/^\s*(?:please\s+)?only\s+/i,"");
      if(/(?:除|剔|跳过|忽略|保留|留着|停止|暂停|取消|撤|改|换|减少|增加|范围|权限|模型|仅|只|单独|部分)|\b(?:except|exclud\w*|without|skip|ignore|omit|minus|instead|rather|only|stop|cancel)\b/i.test(scopeText))throw changed();
      let actionText=publicationActionBounds(scopeText,publicationBounds).text;
      if(operation==="merge_only")actionText=actionText.replace(/(?:暂不|先不|不要|不用|无需|不)(?:进行)?(?:发布|部署)/g,"").replace(/\b(?:do not|don't|not) (?:publish|release|deploy)\b/ig,"");
      if(operation==="publish_only")actionText=actionText.replace(/(?:暂不|先不|不要|不用|无需|不)(?:进行)?合并/g,"").replace(/\b(?:do not|don't|not) merge\b/ig,"");
      actionText=actionText.replace(/(?:PR\s*#?|#)\d+\b/ig,"").replace(/\b[a-f0-9]{7,40}\b/ig,"")
        .replace(/请|现在|直接|立即|继续|执行|开始|帮我|麻烦|把|将|合并|发布|部署|和|并|及|一起|当前|本次|这个|这些|此|全部/g,"")
        .replace(/\b(?:merge|publish|release|deploy|and|please|now|this|these|the|pr|go|ahead)\b/ig,"")
        .replace(/[\s,，;；。.!！、:：]+/g,"");
      // Unparsed artifact/branch/conditional qualifiers cannot authorize the old
      // complete scope. The Agent must prepare the exact intended scope instead.
      if(actionText)throw scopeConflict("qualifier_unsupported","范围限定文字无法完整识别，请核对产物、版本和条件；保留已有决定，不用重复批准或忽略剩余文字放行。");
    }
  };
  assertActionBounds(instruction.text,reviewedDecision);
  const referenceKey=(ref:{repository:string;pullRequest:number})=>`${ref.repository.toLowerCase()}/pull/${ref.pullRequest}`;
  const expected=new Set(references.map(referenceKey));
  const checkReferences=(text:string)=>{
    const mentioned=new Set<string>();
    const add=(matches:typeof references)=>{
      const keys=new Set(matches.map(referenceKey));
      if(keys.size!==1)throw changed();
      for(const key of keys)mentioned.add(key);
    };
    // Repository names may themselves look like hex SHAs. Validate URLs as
    // structured references, then inspect only non-URL text for bare commits.
    const plain=text.replace(/https?:\/\/[^\s<>，。；]+/ig,raw=>{
      let url:URL;
      try {url=new URL(raw.replace(/[).,;!]+$/, ""));} catch {throw changed();}
      const match=url.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|commit)\/([^/]+)\/?$/i);
      if(!match)throw changed();
      if(match) {
        const repository=`${url.origin}/${match[1]}/${match[2]}`;
        add(references.filter(ref=>ref.repository.toLowerCase()===repository.toLowerCase()
          && (match[3]!.toLowerCase()==="pull" ? /^\d+$/.test(match[4]!) && ref.pullRequest===Number(match[4])
            : /^[a-f0-9]{7,40}$/i.test(match[4]!) && ref.head.toLowerCase().startsWith(match[4]!.toLowerCase()))));
      }
      return " ";
    });
    const referenceText=publicationActionBounds(plain,publicationBounds).text;
    for(const match of referenceText.matchAll(/(?:PR\s*#?|#)(\d+)\b/ig))
      add(references.filter(ref=>ref.pullRequest===Number(match[1])));
    for(const match of referenceText.matchAll(/\b[a-f0-9]{7,40}\b/ig))
      add(references.filter(ref=>ref.head.toLowerCase().startsWith(match[0].toLowerCase())));
    return mentioned;
  };
  const currentReferences=checkReferences(instruction.text);
  const currentArtifacts=publicationActionBounds(instruction.text.replace(/https?:\/\/[^\s<>，。；]+/ig," "),publicationBounds).artifacts;
  // An explicitly named subset cannot authorize the rest of a frozen scope.
  if(currentReferences.size && [...expected].some(key=>!currentReferences.has(key)))throw changed();
  const db=database.connection, external=executor.kind==="external", sessionId=executor.sessionId;
  const row=db.prepare(external
    ? `SELECT source_id,json_extract(payload_json,'$.text') AS text,json_extract(payload_json,'$.occurredAt') AS at
       FROM external_native_messages WHERE session_id=? AND json_extract(payload_json,'$.role')='agent'
       AND json_extract(payload_json,'$.phase')='final_answer' AND instr(json_extract(payload_json,'$.text'),'原会话执行范围：')>0
       AND (julianday(json_extract(payload_json,'$.occurredAt'))<julianday(?) OR julianday(json_extract(payload_json,'$.occurredAt')) IS NULL)
       ORDER BY position DESC,rowid DESC LIMIT 1`
    : `SELECT source_id,text,occurred_at AS at FROM agent_session_messages WHERE session_id=? AND role='agent'
       AND phase='final_answer' AND instr(text,'原会话执行范围：')>0
       AND (julianday(occurred_at)<julianday(?) OR julianday(occurred_at) IS NULL) ORDER BY position DESC,rowid DESC LIMIT 1`)
    .get(sessionId,retry?.occurredAt ?? instruction.occurredAt) as {source_id:string;text:string;at:string|null}|undefined;
  if(!row)return undefined;
  if(!row.at || !Number.isFinite(Date.parse(row.at)))throw missing();
  const key=external?`external:${sessionId}`:`dispatch:${executor.dispatchId}`;
  const clock=db.prepare("SELECT occurred_at FROM session_message_times WHERE session_key=? AND source_id=? AND provenance='source_message'")
    .get(key,`native:${row.source_id}`) as {occurred_at:string}|undefined;
  if(!clock || Date.parse(clock.occurred_at)!==Date.parse(row.at))throw missing();
  if(Date.parse(row.at)>=Date.parse(instruction.occurredAt))return undefined;
  if(!containsConversationScope(row.text,reviewText))return undefined;

  // The current input still needs its own authorization. Do not infer consent
  // from old input, progress, a tool parameter or an unbound "approve".
  const latest = retry ?? instruction;
  const users=db.prepare(external
    ? `SELECT source_id,json_extract(payload_json,'$.text') AS text,json_extract(payload_json,'$.occurredAt') AS at,
       json_extract(payload_json,'$.clientMessageId') AS client_message_id
       FROM external_native_messages WHERE session_id=? AND json_extract(payload_json,'$.role')='user'
       AND COALESCE(json_extract(payload_json,'$.phase'),'')<>'execution'
       AND (julianday(json_extract(payload_json,'$.occurredAt')) BETWEEN julianday(?) AND julianday(?) OR julianday(json_extract(payload_json,'$.occurredAt')) IS NULL)`
    : `SELECT source_id,text,occurred_at AS at,client_message_id FROM agent_session_messages WHERE session_id=? AND role='user'
       AND COALESCE(phase,'')<>'execution' AND (julianday(occurred_at) BETWEEN julianday(?) AND julianday(?) OR julianday(occurred_at) IS NULL)`)
    .all(sessionId,row.at,latest.occurredAt) as {source_id:string;client_message_id:string|null;text:string;at:string|null}[];
  const commands=db.prepare(external
    ? "SELECT id,text,created_at AS at,status FROM external_native_commands WHERE session_id=? AND julianday(created_at) BETWEEN julianday(?) AND julianday(?)"
    : "SELECT id,text,created_at AS at,status FROM agent_session_commands WHERE session_id=? AND kind='message' AND julianday(created_at) BETWEEN julianday(?) AND julianday(?)")
    .all(sessionId,row.at,latest.occurredAt) as {id:string;text:string;at:string;status:string}[];
  const explicitRenewal=!reviewedDecision && expected.size>0 && currentReferences.size===expected.size
    && (operation==="merge_only" || publicationBounds.requiredArtifacts.length>0 && currentArtifacts.length===publicationBounds.requiredArtifacts.length);
  if(!external) {
    const interrupts=db.prepare("SELECT status,created_at AS at FROM agent_session_commands WHERE session_id=? AND kind='interrupt' AND status NOT IN ('failed','cancelled') AND julianday(created_at) BETWEEN julianday(?) AND julianday(?)").all(sessionId,row.at,latest.occurredAt) as {status:string;at:string}[];
    if(interrupts.some(i=>!explicitRenewal || i.status!=="delivered" || Date.parse(i.at)>=Date.parse(instruction.occurredAt)))
      throw scopeConflict("stopped","范围审阅后出现停止；只有后续明确重授同一完整 PR 和产物范围才可恢复，普通继续或进度询问不会解除停止。");
  }
  for(const user of users) {
    if(!user.at || !Number.isFinite(Date.parse(user.at)))throw missing();
    const observed=db.prepare("SELECT occurred_at FROM session_message_times WHERE session_key=? AND source_id=? AND provenance='source_message'").get(key,`native:${user.source_id}`) as {occurred_at:string}|undefined;
    if(!observed || Date.parse(observed.occurred_at)!==Date.parse(user.at))throw missing();
  }
  for(const command of commands)if(!["delivered","failed","cancelled"].includes(command.status))throw missing();
  const inputs=distinctConversationInputs(commands, users);
  for(const input of inputs) {
    // Exact current command and its clocked mirror are checked by integrationInstruction.
    if(input.text===instruction.text && Date.parse(input.at!)===Date.parse(instruction.occurredAt))continue;
    if (retry && Date.parse(input.at!) > Date.parse(instruction.occurredAt) && (isIntegrationRetry(input.text) || isIntegrationContinue(input.text) || isIntegrationStatus(input.text))) continue;
    if (retry && Date.parse(input.at!) >= Date.parse(instruction.occurredAt)) throw changed();
    const text=input.text.trim();
    // These bounded non-execution messages do not change a reviewed code scope.
    if(/^(?:请)?(?:进度(?:如何)?|查看进度|当前状态|状态如何|继续(?:执行|处理)?|同意|批准|提交)[。.!！]?$/i.test(text))continue;
    if(explicitRenewal && /^(?:请)?(?:停止|暂停|取消)(?:执行)?[。.!！]?$/.test(text) && Date.parse(input.at!)<Date.parse(instruction.occurredAt))continue;
    if(/(?:停止|暂停|取消|撤|不要|别|先不|改|换|仅|只|排除|增加|减少|范围|权限|模型)|\b(?:except|exclud\w*|without|skip|ignore|omit|minus|instead|rather|only|stop|cancel)\b/i.test(text.replace(/https?:\/\/[^\s<>，。；]+/ig," "))) {
      const stopped=/^(?:请)?(?:停止|暂停|取消)(?:执行)?[。.!！]?$/.test(text);
      throw scopeConflict(stopped?"stopped":"intervening_scope_changed",stopped
        ?"范围审阅后出现停止、范围变化或歧义：原停止仍有效；仅后续明确重授同一完整 PR 和全部产物才可恢复，普通继续不解锁。"
        :"范围审阅后出现停止、范围变化或歧义：存在中间范围或条件变更，请核对并展示当前完整范围，不反复批准旧范围。");
    }
    if(/条目/.test(text) && /(?:建|提交|登记)/.test(text) && !/合并|发布|部署|PR\s*#?\d+/i.test(text))continue;
    try { assertIntegrationInstruction(text,operation); assertActionBounds(text); }
    catch { throw changed(); }
    const intermediateReferences=checkReferences(text);
    if(intermediateReferences.size && [...expected].some(key=>!intermediateReferences.has(key)))
      throw scopeConflict("reference_subset","中间执行指令仅覆盖部分 PR，不能由后续笼统指令扩展到完整范围；请核对当前完整范围与决定。");
  }
  return {sourceId:row.source_id,occurredAt:row.at,textDigest:integrationFingerprint(row.text),reviewDigest,
    executorBinding:executor.binding,settings:executor.settings,instructionSourceId:instruction.sourceId};
}
