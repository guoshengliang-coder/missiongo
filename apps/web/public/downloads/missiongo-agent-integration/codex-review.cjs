#!/usr/bin/env node
// Optional native lifecycle context only. Never blocks Stop or synthesizes an
// input/approval. Installing this hook still requires Codex's own trust flow.
const chunks = []; let bytes = 0;
process.stdin.on("data", chunk => { bytes += chunk.length; if (bytes <= 65536) chunks.push(chunk); });
process.stdin.on("end", async () => {
  if (bytes > 65536) return;
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!["SessionStart", "UserPromptSubmit"].includes(input.hook_event_name) || typeof input.cwd !== "string") return;
    const { nativeReviewContext } = await import("./missiongo-review/review-cli.mjs");
    const context = nativeReviewContext(input.cwd, undefined, { agentKind: "codex", sessionRef: input.session_id });
    if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: context } }));
  } catch { /* Missing or disabled review must not prevent native startup. */ }
});
