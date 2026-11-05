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
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (process.env.TEST_AGENT_EVENTS) appendFileSync(process.env.TEST_AGENT_EVENTS, line + "\n");
  if (codex) {
    if (message.method === "initialize") emit({ id: message.id, result: {} });
    else if (["thread/start","thread/resume"].includes(message.method)) {
      policy={...policy,...message.params,model:"fixture-model"};
      emit({ id: message.id, result: {...policy,thread:{id:ref},
        sandbox:{type:process.env.FAKE_BAD_POLICY ? "dangerFullAccess" : policy.sandbox==="read-only" ? "readOnly" : "workspaceWrite",writableRoots:policy.runtimeWorkspaceRoots}} });
    }
    else if (message.method === "mcpServer/tool/call") emit({ id: message.id, result: { structuredContent: {
      capabilities: { canComment: !process.env.FAKE_READ_ONLY, writeTools: process.env.FAKE_READ_ONLY ? [] : ["claim_item", "append_comment"] },
      skill: { expectedVersion: process.env.FAKE_SKILL_STALE ? "2.0.0" : "1.0.0" },
    } } });
    else if (message.method === "thread/read") emit({ id: message.id, result: { thread: { id: ref, turns: [turn] } } });
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
    emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: message.request.subtype==="set_permission_mode" ? {mode:message.request.mode} : {} } });
  } else if (message.type === "user") {
    emit({ type: "system", subtype: "init", session_id: session });
    emit(message);
    emit({ type: "assistant", uuid: `agent-${message.uuid}`, message: { content: [{ type: "text", text: "fixture received" }] } });
    if (message.message.content[0].text.includes("approval")) emit({ type: "control_request", request_id: "claude-native-1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo test" } } });
    else emit({ type: "result", is_error: false });
  } else if (message.type === "control_response") {
    emit({ type: "assistant", uuid: "decision", message: { content: [{ type: "text", text: message.response.response.behavior }] } });
    emit({ type: "result", is_error: false });
  }
});
