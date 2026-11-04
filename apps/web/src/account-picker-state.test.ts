import { describe, expect, it } from "vitest";

import { accountPickerState, nextEnabledIndex } from "./account-picker-state";

describe("product-access picker state", () => {
  const granted = new Set(["account-1"]);
  const queued = new Set(["new@example.com"]);

  it("marks an account already on the product", () => {
    expect(accountPickerState({ id: "account-1", email: "member@example.com" }, granted, queued)).toBe("granted");
  });

  it("marks an account queued for the next save, whatever the address's case", () => {
    expect(accountPickerState({ id: "account-2", email: "New@Example.com" }, granted, queued)).toBe("queued");
  });

  it("leaves everyone else selectable", () => {
    expect(accountPickerState({ id: "account-3", email: "other@example.com" }, granted, queued)).toBe("selectable");
  });

  it("prefers queued over granted when both are true", () => {
    // Re-picking someone the table already shows would otherwise claim they are
    // already on the product while a second row waits for the same save.
    expect(accountPickerState({ id: "account-1", email: "new@example.com" }, granted, queued)).toBe("queued");
  });
});

describe("picker keyboard movement", () => {
  const enabled = (index: number) => index !== 1;

  it("starts at the top when nothing is highlighted and the arrow points down", () => {
    expect(nextEnabledIndex(3, -1, 1, enabled)).toBe(0);
  });

  it("starts at the bottom when nothing is highlighted and the arrow points up", () => {
    expect(nextEnabledIndex(3, -1, -1, enabled)).toBe(2);
  });

  it("skips rows that cannot be chosen", () => {
    expect(nextEnabledIndex(3, 0, 1, enabled)).toBe(2);
    expect(nextEnabledIndex(3, 2, -1, enabled)).toBe(0);
  });

  it("stays put when every remaining row is disabled", () => {
    expect(nextEnabledIndex(2, 0, 1, () => false)).toBe(0);
  });
});
