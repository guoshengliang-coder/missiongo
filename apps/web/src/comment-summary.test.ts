import { describe, expect, it } from "vitest";

import { commentAuthor, commentPlainText, deriveSummary } from "./comment-summary";

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
