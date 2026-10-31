import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownText } from "./markdown-text";

const render = (text: string) => renderToStaticMarkup(<MarkdownText>{text}</MarkdownText>);

describe("MarkdownText", () => {
  it("renders CJK labels beside punctuation and unspaced body text", () => {
    const html = render("- **读到的： **文字\n- **我的判断：**当前正文\n- *说明：*继续\n- __方案：__继续");
    for (const label of ["读到的：", "我的判断：", "方案："]) expect(html).toContain(`<strong>${label}</strong>`);
    expect(html).toContain("<em>说明：</em>继续");
    expect(html).not.toContain("**");
  });

  it("keeps code, escaped markers, URL destinations and unmatched emphasis literal", () => {
    const html = render("`**我的判断：**正文`\n\n```md\n**我的判断：**正文\n```\n\n\\*\\*我的判断：\\*\\*正文\n\n[查看](https://example.invalid/**中文：**正文)\n\n**未闭合：\n\nordinary**word**text");
    expect(html).toContain("<code>**我的判断：**正文</code>");
    expect(html).toContain('<code class="language-md">**我的判断：**正文');
    expect(html).toContain("<p>**我的判断：**正文</p>");
    expect(decodeURI(html)).toContain('href="https://example.invalid/**中文：**正文"');
    expect(html).toContain("**未闭合：");
    expect(html).not.toContain("<strong>我的判断");
  });

  it("supports nested formatting, quotes, task lists and safe links", () => {
    const html = render("> **标题** 和 *斜体*、~~删除~~\n\n- [x] 完成\n- [ ] 待做\n\n**粗体含 `代码`**\n\n[安全](https://example.invalid) [危险](javascript:alert%281%29)");
    for (const tag of ["<blockquote>", "<strong>", "<em>", "<del>", 'type="checkbox"', "<code>代码</code>"]) expect(html).toContain(tag);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('href="javascript:');
  });

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
