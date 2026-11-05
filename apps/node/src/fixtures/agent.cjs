#!/usr/bin/env node
// Isolated wire-protocol fixture: no network, model requests, or real credentials.
const { createInterface } = require("node:readline");
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("fixture 1.0.0"); process.exit(0); }
const codex = args[0] === "app-server";
const session = args[args.indexOf("--session-id") + 1];
const emit = (data) => process.stdout.write(JSON.stringify(data) + "\n");
let turn = { id: "turn-1", status: "completed", items: [] };
let ref = "thread-1";
let policy;
let claudeMode = args[args.indexOf("--permission-mode") + 1];
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (process.env.TEST_AGENT_EVENTS) appendFileSync(process.env.TEST_AGENT_EVENTS, line + "\n");
  if (codex) {
    if (message.method === "initialize") emit({ id: message.id, result: {} });
    else if (["thread/start","thread/resume"].includes(message.method)) {
      if (message.method === "thread/start" || !process.env.FAKE_IGNORE_RESUME) policy={...policy,...message.params,model:"fixture-model"};
      emit({ id: message.id, result: {...policy,thread:{id:ref,status:{type:"idle"}},
        sandbox:{type:process.env.FAKE_BAD_POLICY ? "dangerFullAccess" : policy.sandbox==="read-only" ? "readOnly" : "workspaceWrite",writableRoots:policy.runtimeWorkspaceRoots}} });
    }
    else if (message.method === "thread/settings/update") {
      if (process.env.FAKE_UNSUPPORTED_SETTINGS) emit({id:message.id,error:{code:-32601,message:"Method not found"}});
      else {
        if (!process.env.FAKE_UNCONFIRMED_UPDATE) policy={...policy,...message.params,sandbox:message.params.sandboxPolicy.type==="readOnly" ? "read-only" : "workspace-write"};
        emit({id:message.id,result:{}});
      }
    }
    else if (message.method === "mcpServer/tool/call") emit({ id: message.id, result: { structuredContent: {
      capabilities: { canComment: !process.env.FAKE_READ_ONLY, writeTools: process.env.FAKE_READ_ONLY ? [] : ["claim_item", "append_comment"] },
      skill: { expectedVersion: process.env.FAKE_SKILL_STALE ? "2.0.0" : "1.0.0" },
    } } });
    else if (message.method === "thread/read") emit({ id: message.id, result: { thread: { id: ref, turns: [turn] } } });
    else if (message.method === "thread/turns/list") emit({ id: message.id, result: { data: [{ ...turn, items: [], itemsView: "notLoaded" }], nextCursor: null } });
    else if (message.method === "thread/items/list") emit({ id: message.id, result: { data: [...turn.items].reverse().map(item => ({ turnId: turn.id, item })), nextCursor: null } });
    else if (["turn/start", "turn/steer"].includes(message.method)) {
      turn.items.push({ id: `user-${turn.items.length}`, type: "userMessage", content: message.params.input });
      emit({ id: message.id, result: { turn } });
      if (message.params.input[0].text.includes("auto-denied")) emit({ method: "item/autoApprovalReview/completed", params: {
        threadId: ref, turnId: turn.id, reviewId: "review-1", startedAtMs: Date.now(), review: { status: "denied", rationale: "fixture denied" }, action: { type: "command", command: "echo test" },
      } });
      if (message.params.input[0].text.includes("approval")) emit({ id: "native-approval", method: "item/commandExecution/requestApproval",
        params: { threadId: ref, turnId: turn.id, command: "echo test", availableDecisions: ["accept", "decline"] } });
    } else if (message.id === "native-approval" && message.result) {
      turn.items.push({ id: "decision", type: "agentMessage", text: message.result.decision });
    } else if (message.id) emit({ id: message.id, result: {} });
  } else if (message.type === "control_request") {
    const respond = () => {
      if (message.request.subtype === "set_permission_mode" && process.env.FAKE_CLAUDE_REJECT_MODE === message.request.mode) {
        emit({type:"control_response",response:{subtype:"error",request_id:message.request_id,error:"fixture mode denied"}}); return;
      }
      if (message.request.subtype === "set_permission_mode") claudeMode = message.request.mode;
      emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
        response: message.request.subtype==="set_permission_mode" ? {mode:claudeMode} : {remote_control_available:false} } });
    };
    if (message.request.subtype === "set_permission_mode" && process.env.FAKE_CLAUDE_ACK_DELAY) setTimeout(respond, Number(process.env.FAKE_CLAUDE_ACK_DELAY));
    else respond();
  } else if (message.type === "user") {
    if (process.env.TEST_AGENT_EVENTS) appendFileSync(process.env.TEST_AGENT_EVENTS, JSON.stringify({fixture:"received_user",mode:claudeMode,uuid:message.uuid})+"\n");
    emit({ type: "system", subtype: "init", session_id: session });
    emit(message);
    emit({ type: "assistant", uuid: `agent-${message.uuid}`, message: { content: [{ type: "text", text: "fixture received" }] } });
    const prompt = message.message.content[0].text;
    if (prompt.startsWith("elicitation")) {
      const request = { subtype: "elicitation", mcp_server_name: "fixture", mode: "form", message: "Review exact fixture plan and validation goals.",
        requested_schema: { type: "object", properties: {}, required: [], additionalProperties: false } };
      if (prompt.includes("fields")) request.requested_schema.properties = { name: { type: "string" } };
      if (prompt.includes("url")) { request.mode = "url"; request.url = "https://fixture.invalid/review"; }
      if (prompt.includes("unknown")) request.subtype = "future_confirmation";
      emit({ type: "control_request", request_id: "mcp-confirm-1", request });
      emit({ type: "tool_progress", tool_name: "mcp__fixture__confirm", elapsed_time_seconds: 30, heartbeat: true });
      if (prompt.includes("parallel")) {
        emit({ type: "control_request", request_id: "mcp-confirm-2", request });
        setTimeout(() => emit({type:"control_cancel_request",request_id:"mcp-confirm-1"}), 100);
      }
    }
    else if (message.message.content[0].text.includes("native-plan-fixture")) emit({ type: "control_request", request_id: "claude-plan-1",
      request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "Implement the reviewed scope and verify the original entry points." } } });
    else if (prompt.includes("approval")) emit({ type: "control_request", request_id: "claude-native-1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo test" } } });
    else emit({ type: "result", is_error: false });
  } else if (message.type === "control_response") {
    const response = message.response;
    const answer = response.response;
    if (response.request_id.startsWith("mcp-confirm-")) {
      if (response.subtype === "success") {
        if (!["accept", "decline", "cancel"].includes(answer.action) || "behavior" in answer) throw new Error("Incorrect elicitation response");
        if (answer.action === "accept" && JSON.stringify(answer.content) !== "{}") throw new Error("Missing empty form content");
      }
    }
    emit({ type: "assistant", uuid: "decision", message: { content: [{ type: "text", text: answer?.action ?? answer?.behavior ?? response.error }] } });
    emit({ type: "result", is_error: false });
  }
});
