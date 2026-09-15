import { describe, expect, it } from "vitest";

import { closeAccountEditor, openAccountEditor } from "./account-edit-state";

describe("account edit intent", () => {
  it("starts in view mode and opens the requested editor", () => {
    expect(openAccountEditor(null, "email")).toBe("email");
    expect(openAccountEditor(null, "new-account")).toBe("new-account");
    expect(openAccountEditor(null, "account:abc")).toBe("account:abc");
  });

  it("does not replace an open editor with a different intent", () => {
    expect(openAccountEditor("email", "password")).toBe("email");
    expect(openAccountEditor("account:abc", "account:def")).toBe("account:abc");
    expect(openAccountEditor("account:abc", "new-account")).toBe("account:abc");
  });

  it("only closes the editor named by the cancel action", () => {
    expect(closeAccountEditor("password", "password")).toBeNull();
    expect(closeAccountEditor("account:abc", "account:def")).toBe("account:abc");
  });
});

