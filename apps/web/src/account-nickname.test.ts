import { describe, expect, it } from "vitest";

import { draftDisplayName, nicknameDraftChanged, parseNicknameDraft } from "./account-nickname";

const user = { username: "liangguosheng@example.com" } as const;

describe("parseNicknameDraft", () => {
  it("sends null for a blank field rather than an empty name", () => {
    expect(parseNicknameDraft("")).toEqual({ ok: true, nickname: null });
    expect(parseNicknameDraft("   ")).toEqual({ ok: true, nickname: null });
  });

  it("folds whitespace, because a byline sits on one line", () => {
    expect(parseNicknameDraft("  阿  亮 ")).toEqual({ ok: true, nickname: "阿 亮" });
    expect(parseNicknameDraft("two\nlines")).toEqual({ ok: true, nickname: "two lines" });
  });

  it("refuses a name past the server's limit, counted the way the server counts", () => {
    expect(parseNicknameDraft("x".repeat(40))).toEqual({ ok: true, nickname: "x".repeat(40) });
    expect(parseNicknameDraft("x".repeat(41))).toEqual({ ok: false, reason: "tooLong" });
  });
});

describe("nicknameDraftChanged", () => {
  it("does not offer a save that would change nothing", () => {
    expect(nicknameDraftChanged("阿亮", { nickname: "阿亮" })).toBe(false);
    expect(nicknameDraftChanged("  阿亮 ", { nickname: "阿亮" })).toBe(false);
    // An unset nickname and a blank field are the same thing.
    expect(nicknameDraftChanged("", {})).toBe(false);
    expect(nicknameDraftChanged("   ", {})).toBe(false);
  });

  it("offers one when the name would differ, including clearing it", () => {
    expect(nicknameDraftChanged("阿亮", {})).toBe(true);
    expect(nicknameDraftChanged("", { nickname: "阿亮" })).toBe(true);
  });
});

describe("draftDisplayName", () => {
  it("previews the fallback while the field is empty", () => {
    expect(draftDisplayName("", user)).toBe("liangguosheng");
    expect(draftDisplayName("阿亮", user)).toBe("阿亮");
  });

  it("stays on the current name while the draft cannot be saved", () => {
    expect(draftDisplayName("x".repeat(41), { ...user, nickname: "阿亮" })).toBe("阿亮");
    expect(draftDisplayName("x".repeat(41), user)).toBe("liangguosheng");
  });

  it("copes with a username that is not an address, which a seeded account may have", () => {
    expect(draftDisplayName("", { username: "local-admin" })).toBe("local-admin");
  });
});
