import { describe, expect, it } from "vitest";

import {
  draftDisplayName,
  MAX_NODE_NICKNAME_LENGTH,
  nicknameDraftChanged,
  parseNicknameDraft,
} from "./node-nickname";

const machine = (nickname?: string) => ({ deviceName: "Mac mini", ...(nickname ? { nickname } : {}) });

describe("reading the nickname field", () => {
  it("trims what was typed", () => {
    expect(parseNicknameDraft("  Studio  ")).toEqual({ ok: true, nickname: "Studio" });
  });

  it("treats a blank field as clearing the nickname", () => {
    expect(parseNicknameDraft("")).toEqual({ ok: true, nickname: null });
    expect(parseNicknameDraft("   ")).toEqual({ ok: true, nickname: null });
  });

  it("takes exactly the server's limit and refuses one character more", () => {
    expect(MAX_NODE_NICKNAME_LENGTH).toBe(40);
    expect(parseNicknameDraft("a".repeat(40))).toEqual({ ok: true, nickname: "a".repeat(40) });
    expect(parseNicknameDraft("a".repeat(41))).toEqual({ ok: false, reason: "tooLong" });
  });

  it("counts the length after trimming, like the server", () => {
    expect(parseNicknameDraft(` ${"a".repeat(40)} `).ok).toBe(true);
  });
});

describe("whether the nickname has been edited", () => {
  it("is unchanged when the field still shows the saved nickname, give or take spaces", () => {
    expect(nicknameDraftChanged("Studio", machine("Studio"))).toBe(false);
    expect(nicknameDraftChanged(" Studio ", machine("Studio"))).toBe(false);
  });

  it("is unchanged when there is no nickname and the field is blank", () => {
    expect(nicknameDraftChanged("  ", machine())).toBe(false);
  });

  it("changes when a nickname is typed, edited or cleared", () => {
    expect(nicknameDraftChanged("Studio", machine())).toBe(true);
    expect(nicknameDraftChanged("Office", machine("Studio"))).toBe(true);
    expect(nicknameDraftChanged("", machine("Studio"))).toBe(true);
  });

  it("counts an over-long draft as changed, so its refusal is what the person sees", () => {
    expect(nicknameDraftChanged("a".repeat(41), machine())).toBe(true);
  });
});

describe("the name sessions would start with", () => {
  it("falls back to the device name without a nickname", () => {
    expect(draftDisplayName("", machine())).toBe("Mac mini");
    expect(draftDisplayName("", machine("Studio"))).toBe("Mac mini");
  });

  it("follows the nickname being typed", () => {
    expect(draftDisplayName(" Studio ", machine())).toBe("Studio");
  });

  it("stays on the saved name while the draft is too long to save", () => {
    expect(draftDisplayName("a".repeat(41), machine("Studio"))).toBe("Studio");
    expect(draftDisplayName("a".repeat(41), machine())).toBe("Mac mini");
  });
});
