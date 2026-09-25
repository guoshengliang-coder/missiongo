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
});
