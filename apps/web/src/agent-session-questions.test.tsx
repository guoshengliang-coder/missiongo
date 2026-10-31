import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentSessionQuestions } from "./agent-session-questions";
import { I18nProvider } from "./i18n";
import type { AgentSessionQuestion } from "./types";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => undefined,
  },
});

function render(node: ReactNode): string {
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
}

describe("agent session questions", () => {
  it("draws the detail under the short title and offers the options", () => {
    const question: AgentSessionQuestion = {
      title: "确认操作",
      detail: "是否继续执行后续操作？",
      options: ["继续", "停止"],
      key: "q0",
    };
    const html = render(
      <AgentSessionQuestions questions={[question]} reply="" canReply onChange={() => undefined} />,
    );
    expect(html).toContain("确认操作");
    expect(html).toContain("是否继续执行后续操作？");
    expect(html).toContain(">继续<");
    expect(html).toContain(">停止<");
    expect(html).not.toContain("agent-session-question-input");
  });

  it("adds a free-text field when the question also takes a custom answer", () => {
    const question: AgentSessionQuestion = {
      title: "确认操作",
      detail: "是否继续执行后续操作？",
      options: ["继续", "停止"],
      key: "q0",
      custom: true,
    };
    const html = render(
      <AgentSessionQuestions questions={[question]} reply="" canReply onChange={() => undefined} />,
    );
    expect(html).toContain("agent-session-question-input");
    expect(html).toContain("输入你自己的回答");
  });

  it("keeps a keyed text field a plain input with no options", () => {
    const question: AgentSessionQuestion = { title: "备注", key: "note", kind: "text" };
    const html = render(
      <AgentSessionQuestions questions={[question]} reply="" canReply onChange={() => undefined} />,
    );
    expect(html).toContain("agent-session-question-input");
    expect(html).not.toContain("agent-session-options");
  });

  it("shows a delivered choice as selected history rather than a new prompt", () => {
    const html = render(
      <AgentSessionQuestions
        questions={[{ title: "是否继续？", options: ["继续", "停止"], answered: "继续" }]}
        reply="" canReply onChange={() => undefined}
      />,
    );
    expect(html).toContain('class="agent-session-question answered"');
    expect(html).toContain("已回答");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*class="selected"[^>]*>继续<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>停止<\/button>/);
    expect(html).not.toContain("agent-session-question-draft");
  });

  it("shows a key-less selection as an unsent draft, following edits and clearing (AND-347)", () => {
    const question = { title: "选择范围", options: ["人工评论、MCP", "仅人工评论"] };
    for (const reply of ["人工评论、MCP", "仅人工评论", "自定义回复", ""]) {
      const html = render(<AgentSessionQuestions questions={[question]} reply={reply} canReply onChange={() => undefined} />);
      const selected = question.options.includes(reply);
      expect(html.includes("已选择，未发送")).toBe(selected);
      expect(html.includes('aria-pressed="true"')).toBe(selected);
      expect(html).not.toContain("已回答");
      if (selected) expect(html).toContain(`aria-pressed="true">${reply}</button>`);
    }
  });

  it("matches each unkeyed question by its labelled line in a group (AND-347)", () => {
    const questions = [
      { header: "范围", title: "选择范围", options: ["全部", "部分"] },
      { header: "确认", title: "是否继续", kind: "boolean" as const },
    ];
    const html = render(<AgentSessionQuestions questions={questions} reply={"范围: 部分\n确认: 是"} canReply onChange={() => undefined} />);
    expect(html).toContain('aria-pressed="true">部分</button>');
    expect(html).toContain('aria-pressed="true">是</button>');
    expect(html).toContain('aria-pressed="false">全部</button>');
  });

  it("drops a withdrawn card instead of drawing a dead ask (AND-239)", () => {
    const withdrawn: AgentSessionQuestion = {
      title: "OpenCode 请求使用 bash",
      options: ["允许一次", "始终允许", "拒绝"],
      withdrawn: true,
    };
    const html = render(
      <AgentSessionQuestions questions={[withdrawn]} reply="" canReply onChange={() => undefined} />,
    );
    expect(html).toBe("");
  });

  it("keeps the live question when one of several went away (AND-239)", () => {
    const html = render(
      <AgentSessionQuestions
        questions={[
          { title: "已自动放行的字段", options: ["继续"], withdrawn: true },
          { title: "仍需确认的字段", options: ["继续", "停止"] },
        ]}
        reply="" canReply onChange={() => undefined}
      />,
    );
    expect(html).toContain("仍需确认的字段");
    expect(html).not.toContain("已自动放行的字段");
  });
});
