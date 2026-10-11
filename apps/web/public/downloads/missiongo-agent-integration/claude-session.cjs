#!/usr/bin/env node
// SessionStart hook: report this session's identity, without reading history,
// credentials or configuration. Installing it never grants a live CLI stdin.
let bytes = 0;
const chunks = [];
process.stdin.on("data", (chunk) => {
  bytes += chunk.length;
  if (bytes <= 65536) chunks.push(chunk);
});
process.stdin.on("end", () => {
  if (bytes > 65536) return;
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (input.hook_event_name !== "SessionStart" || typeof input.session_id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.session_id)) return;
    const session = { agentKind: "claude_code", sessionRef: input.session_id.toLowerCase(), refKind: "native", autoConnect: true };
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart",
      additionalContext: "MissionGo current native session identity (from SessionStart): " + JSON.stringify(session)
        + ". Use only for user-directed item handling under MissionGo Skill. Reuse a known tracking sessionId when upgrading. "
        + "Web input requires an existing MissionGoClaudeBridge host; this hook does not attach stdin or authorize a handoff." } }));
  } catch { /* An optional identity hook must not prevent CLI startup. */ }
});
