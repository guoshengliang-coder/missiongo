import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { errorMessageKey, localizedErrorText } from "./error-text";

const t = (key: string) => `<${key}>`;

describe("localizedErrorText", () => {
  it("replaces the server's English sign-in message", () => {
    const error = new ApiError(401, "authentication_required", "A signed-in account is required.");
    expect(localizedErrorText(error, t)).toBe("<errorSignedOut>");
  });

  it("names the failures a person can act on", () => {
    expect(errorMessageKey(new ApiError(403, "forbidden", "Forbidden."))).toBe("errorForbidden");
    expect(errorMessageKey(new ApiError(404, "not_found", "Not found."))).toBe("errorNotFound");
    expect(errorMessageKey(new ApiError(429, "rate_limit_exceeded", "Slow down."))).toBe("errorRateLimited");
    expect(errorMessageKey(new ApiError(503, "request_failed", "Request failed."))).toBe("errorServer");
    expect(errorMessageKey(new TypeError("Failed to fetch"))).toBe("errorNetwork");
  });

  it("translates the conflict codes the console can meet (AND-224)", () => {
    expect(errorMessageKey(new ApiError(409, "agent_stop_pending", "Stop pending."))).toBe("agentSessionStopQueued");
    expect(errorMessageKey(new ApiError(409, "agent_reply_pending", "Reply pending."))).toBe("errorAgentReplyPending");
    expect(errorMessageKey(new ApiError(409, "agent_not_running", "Not running."))).toBe("errorAgentNotRunning");
    expect(errorMessageKey(new ApiError(409, "agent_turn_unavailable", "Turn unavailable."))).toBe("errorAgentTurnUnavailable");
    expect(errorMessageKey(new ApiError(409, "agent_command_pending", "Command pending."))).toBe("errorAgentCommandPending");
    expect(errorMessageKey(new ApiError(409, "agent_reply_changed", "Reply changed."))).toBe("errorAgentReplyChanged");
    expect(errorMessageKey(new ApiError(409, "agent_attention_changed", "Attention changed."))).toBe("errorAgentAttentionChanged");
    expect(errorMessageKey(new ApiError(409, "dispatch_not_retryable", "Not retryable."))).toBe("errorDispatchNotRetryable");
  });

  it("says timeout when the request deadline ends it (AND-224)", () => {
    expect(errorMessageKey(new DOMException("The operation timed out.", "TimeoutError"))).toBe("errorTimeout");
    // An abort the page itself asked for stays untranslated noise.
    expect(errorMessageKey(new DOMException("Aborted", "AbortError"))).toBeNull();
  });

  it("keeps a specific validation message rather than hiding it", () => {
    const error = new ApiError(400, "validation_failed", "Title must not be empty.");
    expect(localizedErrorText(error, t)).toBe("Title must not be empty.");
  });

  it("falls back to a generic sentence when there is nothing to show", () => {
    expect(localizedErrorText("boom", t)).toBe("<somethingWentWrong>");
  });
});
