import { describe, expect, it } from "vitest";

import { commentAuthor, commentPlainText, creatorLabel, creatorShort, deriveSummary } from "./comment-summary";

describe("who wrote a comment", () => {
  it("names the machine and the program", () => {
    expect(commentAuthor(
      { actorKind: "agent", clientName: "Claude Code", agentName: "Claude Code · Macbook-M5" },
      "AI",
    )).toBe("Claude Code · Macbook-M5");
  });

  it("prefixes the verified client when the agent left it out", () => {
    expect(commentAuthor({ actorKind: "agent", clientName: "Codex", agentName: "thinkpad" }, "AI"))
      .toBe("Codex · thinkpad");
  });

  it("falls back through what it actually knows", () => {
    expect(commentAuthor({ actorKind: "agent", clientName: "Hermes" }, "AI")).toBe("Hermes");
    expect(commentAuthor({ actorKind: "agent", agentName: "Codex · nuc" }, "AI")).toBe("Codex · nuc");
    // Every comment written before any of this existed.
    expect(commentAuthor({ actorKind: "agent" }, "AI")).toBe("AI");
  });

  it("leaves people and the system alone", () => {
    expect(commentAuthor({ actorKind: "human", agentName: "spoofed" }, "人工")).toBe("人工");
    expect(commentAuthor({ actorKind: "system" }, "系统")).toBe("系统");
  });

  it("shows an attributed human account nickname", () => {
    expect(commentAuthor({ actorKind: "human", accountName: "梁国盛" }, "人工")).toBe("梁国盛");
    expect(commentAuthor({ actorKind: "human" }, "人工")).toBe("人工");
  });
});

describe("falling back to a derived summary", () => {
  it("takes the first sentence, keeping its punctuation", () => {
    expect(deriveSummary("返回行为已修复。原因是每次打开都推了一条历史。")).toBe("返回行为已修复。");
    expect(deriveSummary("Fixed the back button. It pushed an entry per item.")).toBe("Fixed the back button.");
  });

  it("truncates a run-on rather than returning a paragraph", () => {
    const long = "a".repeat(400);
    const summary = deriveSummary(long);
    expect(summary).toHaveLength(121);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("collapses the whitespace a pasted comment brings with it", () => {
    expect(deriveSummary("  line one\n\n  line two")).toBe("line one");
  });

  it("has nothing to say about an empty comment", () => {
    expect(deriveSummary("   ")).toBe("");
  });
});

describe("reading a comment body as plain text", () => {
  it("leads an analysis with its finding", () => {
    const text = commentPlainText("structured", {
      understanding: "要修返回",
      finding: "每次打开都推了历史",
      evidence: ["App.tsx:383"],
      openQuestions: [],
    });
    expect(text.startsWith("每次打开都推了历史")).toBe(true);
    expect(text).toContain("App.tsx:383");
  });

  it("reads a free comment as its text", () => {
    expect(commentPlainText("free", { text: "这条先放着" })).toBe("这条先放着");
  });

  it("survives a body missing the fields it expects", () => {
    expect(commentPlainText("structured", {})).toBe("");
    expect(commentPlainText("free", { text: 42 })).toBe("");
  });
});

describe("commentAuthor, with accounts", () => {
  it("signs what a person wrote with their name", () => {
    expect(commentAuthor({ actorKind: "human", accountName: "阿亮" }, "人工")).toBe("阿亮");
  });

  it("falls back where there is no account to name", () => {
    // Events written before accounts were plural, ones written through the
    // deployment's operator token, and anything from a deleted account.
    expect(commentAuthor({ actorKind: "human" }, "人工")).toBe("人工");
    expect(commentAuthor({ actorKind: "human", accountName: "   " }, "人工")).toBe("人工");
  });

  it("never signs the system with a person's name", () => {
    expect(commentAuthor({ actorKind: "system", accountName: "阿亮" }, "系统")).toBe("系统");
  });

  it("never signs an AI's output with the account that authorized it", () => {
    expect(commentAuthor({ actorKind: "agent", clientName: "Codex", accountName: "阿亮" }, "AI")).toBe("Codex");
    expect(commentAuthor({ actorKind: "agent", accountName: "阿亮" }, "AI")).toBe("AI");
  });
});

describe("who created an item (AND-67)", () => {
  const labels = { human: "人工", sdk: "SDK", agent: "AI" };

  it("names a person by nickname, and falls back when the account is gone", () => {
    expect(creatorLabel({ kind: "human", accountId: "a1", name: "阿亮" }, labels)).toBe("阿亮");
    expect(creatorLabel({ kind: "human", accountId: "a1" }, labels)).toBe("人工");
  });

  it("names an app report by the SDK token it came through", () => {
    expect(creatorLabel({ kind: "sdk", name: "Search debug" }, labels)).toBe("SDK · Search debug");
    expect(creatorLabel({ kind: "sdk" }, labels)).toBe("SDK");
  });

  it("names an AI's item by its client, never by the account behind it", () => {
    expect(creatorLabel({ kind: "agent", accountId: "a1", clientName: "Claude Code", agentName: "Claude Code · M4" }, labels))
      .toBe("AI · Claude Code");
    expect(creatorLabel({ kind: "agent", agentName: "Codex · nuc" }, labels)).toBe("AI · Codex · nuc");
    expect(creatorLabel({ kind: "agent", accountId: "a1" }, labels)).toBe("AI");
  });

  it("says nothing when nobody was recorded", () => {
    expect(creatorLabel(undefined, labels)).toBeUndefined();
  });
});

describe("the creator a phone footer can hold", () => {
  it("keeps a two-segment byline whole", () => {
    expect(creatorShort("AI · Claude Code")).toBe("AI · Claude Code");
    expect(creatorShort("SDK · Search debug")).toBe("SDK · Search debug");
    expect(creatorShort("人工")).toBe("人工");
  });

  it("drops the model from a compound AI byline rather than cutting it mid-name", () => {
    expect(creatorShort("AI · OpenCode · DeepSeek V4.1 Flash")).toBe("AI · OpenCode");
  });

  it("says nothing when nobody was recorded", () => {
    expect(creatorShort(undefined)).toBeUndefined();
  });
});
