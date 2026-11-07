import { inputRequired, inputResponse, type ServerContext, type RequestStateCodec } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import type { MissionGoDatabase } from "./storage/database.js";
import { conflict } from "./errors.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Result = Record<string, unknown>;
export interface NativeHumanReview {
  readonly content: unknown;
  /** A current, independently persisted domain decision. Reading never fabricates one. */
  readonly completed?: Result;
}

/** The only new path to human domain writes is a bound native client response.
 * Receipt + domain mutation commit atomically; no tool argument is an approval. */
export class NativeHumanConfirmations {
  constructor(private readonly db: MissionGoDatabase) {}

  async request(input: {
    ctx: ServerContext; codec: RequestStateCodec<{revision:string}>; modern: boolean;
    accountId: string; clientId: string; tool: string; targetId: string; requestKey: string; parameters: unknown;
    description: string; inspect: () => NativeHumanReview; apply: () => Result;
  }) {
    const {ctx}=input;
    const intent = digest([input.accountId,input.clientId,input.tool,input.targetId,input.requestKey,input.parameters]);
    const readReceipt = () => {
      const row=this.db.connection.prepare(`SELECT intent_digest,revision,result_json FROM native_human_confirmations
        WHERE account_id=? AND client_id=? AND tool_name=? AND request_key=?`)
        .get(input.accountId,input.clientId,input.tool,input.requestKey) as {intent_digest:string;revision:string;result_json:string}|undefined;
      if(row&&row.intent_digest!==intent) throw conflict("native_confirmation_key_conflict","This request key belongs to different content or another target.");
      return row;
    };
    const review=input.inspect(); // Current scope/role checks also run on result replays.
    const receipt=readReceipt();
    if(review.completed) return this.result({...review.completed,source:"existing"});
    const revision=digest([intent,review.content]);
    if(receipt) {
      if(receipt.revision!==revision) throw conflict("native_confirmation_changed","The reviewed content changed. Read it again and use a new request key.");
      return this.result(JSON.parse(receipt.result_json) as Result);
    }
    const state=ctx.mcpReq.requestState<{revision:string}>();
    if(state&&state.revision!==revision) throw conflict("native_confirmation_changed","The native answer belongs to different content, action or version.");
    const message=`MissionGo · 原生人工确认\n${input.description}\n\n${JSON.stringify(review.content,null,2)}\n\n仅批准上述对象、版本和动作，不授予其他权限；确认不会启动新的 Agent 回合。`;
    if(message.length>512_000) return this.unavailable(review.content,revision,"confirmation_too_large");
    let choice: "accept" | "decline" | "cancel";
    if(input.modern) {
      const capabilities=(ctx.mcpReq.envelope as Record<string,unknown>|undefined)?.["io.modelcontextprotocol/clientCapabilities"] as {elicitation?:{form?:unknown}}|undefined;
      if(!capabilities?.elicitation?.form) return this.unavailable(review.content,revision,"native_confirmation_unavailable");
      const response=inputResponse(ctx.mcpReq.inputResponses,"humanConfirmation");
      if(response.kind==="missing") return inputRequired({requestState:await input.codec.mint({revision},ctx),inputRequests:{
        humanConfirmation:inputRequired.elicit({message,requestedSchema:{type:"object",properties:{},required:[],additionalProperties:false}}),
      }});
      if(!state||response.kind!=="elicit"||!["accept","decline","cancel"].includes(response.action)) throw conflict("native_confirmation_response_required","Use the original server-bound native response, never a tool argument.");
      if(response.action==="accept"&&(!response.content||typeof response.content!=="object"||Array.isArray(response.content)||Object.keys(response.content).length)) throw conflict("native_confirmation_response_invalid","Confirmation accepts only the empty bound response.");
      choice=response.action;
    } else {
      try {
        const response=await ctx.mcpReq.elicitInput({mode:"form",message,requestedSchema:{type:"object",properties:{},required:[],additionalProperties:false}});
        if(!["accept","decline","cancel"].includes(response.action)) throw new Error("Invalid native answer");
        if(response.action==="accept"&&(!response.content||typeof response.content!=="object"||Array.isArray(response.content)||Object.keys(response.content).length)) throw new Error("Invalid native content");
        choice=response.action;
      } catch {
        const current=input.inspect();
        if(current.completed) return this.result({...current.completed,source:"existing"});
        return this.unavailable(current.content,revision,"native_confirmation_unavailable");
      }
    }
    return this.db.transaction(()=>{
      const current=input.inspect(); // Live permissions + exact version, under the same write lock.
      readReceipt();
      if(current.completed) return this.result({...current.completed,source:"existing"});
      if(digest([intent,current.content])!==revision) throw conflict("native_confirmation_changed","Content changed while awaiting the human decision.");
      const existing=readReceipt();
      if(existing) return this.result(JSON.parse(existing.result_json) as Result);
      const result: Result=choice==="accept" ? {approved:true,source:"native",revision,result:input.apply()}
        : {approved:false,source:"native",revision,choice};
      this.db.connection.prepare(`INSERT INTO native_human_confirmations
        (account_id,client_id,tool_name,target_id,request_key,intent_digest,revision,choice,result_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.accountId,input.clientId,input.tool,input.targetId,input.requestKey,intent,revision,choice,JSON.stringify(result),new Date().toISOString());
      return this.result(result);
    });
  }
  private unavailable(content: unknown, revision: string, code: string) {
    return this.result({approved:false,approvalRequired:true,code,revision,content,
      message:"完整审阅内容已保留在当前会话。此连接无法提供可信原生确认；不把普通回复或 Agent 参数当作批准，不修改对象。"});
  }
  private result(data: Result) {return {content:[{type:"text" as const,text:JSON.stringify(data,null,2)}],structuredContent:data};}
}
