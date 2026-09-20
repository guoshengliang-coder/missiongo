import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownText } from "./markdown-text";

const render = (text: string) => renderToStaticMarkup(<MarkdownText>{text}</MarkdownText>);

describe("MarkdownText", () => {
  it("renders GFM formatting and preserves ordinary line breaks", () => {
    const html = render("# 标题\n\n- 第一项\n- 第二项\n\n普通第一行\n普通第二行\n\n| 列 | 值 |\n| - | - |\n| A | B |");

    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<li>第一项</li>");
    expect(html).toContain("普通第一行<br/>");
    expect(html).toContain("<table>");
  });

  it("does not render raw HTML from item content", () => {
    const html = render("安全文本 <script>alert('x')</script>");

    expect(html).toContain("安全文本 ");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert('x')");
  });
});
