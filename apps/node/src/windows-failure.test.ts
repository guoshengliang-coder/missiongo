import { expect, it } from "vitest";
import { windowsFailure } from "./windows-failure.js";

it("reports fixed native failure categories without forwarding credentials or paths", () => {
  const privateOutput = "C:\\private\\profile fixture-secret MethodException: fixture-secret";
  expect(windowsFailure(privateOutput, undefined, 1)).toBe("exit 1; MethodException");
  expect(windowsFailure("fixture-secret", "fixture-secret", 1)).toBe("exit 1; unclassified");
  expect(windowsFailure(privateOutput, "ETIMEDOUT", null)).toBe("ETIMEDOUT");
  expect(windowsFailure("fixture-secret", undefined, null)).toBe("no exit status; unclassified");
});
