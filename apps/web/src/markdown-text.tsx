import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/**
 * Render user-authored item text consistently. Raw HTML is deliberately
 * skipped: Markdown formatting is useful here, but item content must never
 * become executable or layout-controlling HTML.
 */
export function MarkdownText({ children, className }: { children: string; className?: string }) {
  return (
    <div className={className ? `markdown-text ${className}` : "markdown-text"}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} skipHtml>{children}</ReactMarkdown>
    </div>
  );
}
