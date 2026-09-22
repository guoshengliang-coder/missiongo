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

  it("keeps a specific validation message rather than hiding it", () => {
    const error = new ApiError(400, "validation_failed", "Title must not be empty.");
    expect(localizedErrorText(error, t)).toBe("Title must not be empty.");
  });

  it("falls back to a generic sentence when there is nothing to show", () => {
    expect(localizedErrorText("boom", t)).toBe("<somethingWentWrong>");
  });
});
