// OpenCode V2 local plugin. It only adds the current runtime identity to the
// current model context. It neither reads other sessions nor changes providers.
export function sessionContext(sessionID) {
  if (typeof sessionID !== "string" || !/^[A-Za-z0-9:_-]{1,200}$/.test(sessionID)) return undefined;
  return "MissionGo current native session identity (from OpenCode context hook): "
    + JSON.stringify({ agentKind: "opencode", sessionRef: sessionID, refKind: "native", autoConnect: true })
    + ". Use only for user-directed item handling under MissionGo Skill. If a tracking sessionId is already known, upgrade it with register_agent_session(sessionId) rather than creating another record. "
    + "An enabled MissionGo node must confirm this exact session in the registered shared service before Web replies are available.";
}

export default {
  id: "missiongo-session",
  async setup(ctx) {
    const registration = await ctx.session.hook("context", (event) => {
      const text = sessionContext(event.sessionID);
      if (text) event.system.push({ type: "text", text });
    });
    let review;
    try {
      const { nativeReviewContext } = await import("./missiongo-review/review-cli.mjs");
      review = await ctx.session.hook("context", async event => {
        try {
        const response = await ctx.session.get({ sessionID: event.sessionID });
        const session = response?.data ?? response;
        if (session?.parentID) return;
        const directory = session?.location?.directory;
        const text = typeof directory === "string" ? nativeReviewContext(directory, undefined, { agentKind: "opencode", sessionRef: event.sessionID }) : "";
        if (text) event.system.push({ type: "text", text });
        } catch { /* Optional policy cannot prevent native context creation. */ }
      });
    } catch { /* Identity sync and native use survive missing review assets. */ }
    return async () => { await registration.dispose(); await review?.dispose(); };
  },
};
