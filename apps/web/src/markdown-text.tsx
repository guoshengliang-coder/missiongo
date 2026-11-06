import { useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import { localArtifactPath } from "@missiongo/domain";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { useI18n } from "./i18n";
import { remarkCjkEmphasis } from "./remark-cjk-emphasis";

// A real scroll container keeps wide tables inside every Markdown surface and
// exposes keyboard scrolling on browsers which do not focus scroll areas by default.
function MarkdownTable({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  return <div className="markdown-table-scroll" role="region" aria-label={t("markdownTableScroll")} tabIndex={0}>
    <table>{children}</table>
  </div>;
}

/**
 * Render user-authored item text consistently. Raw HTML is deliberately
 * skipped: Markdown formatting is useful here, but item content must never
 * become executable or layout-controlling HTML.
 */
export function MarkdownText({ children, className, onLocalArtifactOpen, resolveResourceUrl, hideLocalImages = false }: { children: string; className?: string; onLocalArtifactOpen?: (href: string) => void; resolveResourceUrl?: (href: string) => string | undefined; hideLocalImages?: boolean }) {
  // Stable renderer identities keep links mounted while a preview opens/closes,
  // preserving the trigger that the shared modal returns focus to.
  const components = useMemo<Components>(() => ({
          table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
          a: ({ href, children }) => href && localArtifactPath(href)
            ? onLocalArtifactOpen
              ? <button type="button" className="artifact-link" onClick={() => onLocalArtifactOpen(href)}>{children}</button>
              : <span>{children}</span>
            : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
          img: ({ src, alt }) => typeof src === "string" && localArtifactPath(src)
            ? hideLocalImages ? null : onLocalArtifactOpen
              ? <button type="button" className="artifact-link" onClick={() => onLocalArtifactOpen(src)}>{alt || src.split("/").at(-1)}</button>
              : <span>{alt}</span>
            : <img src={src} alt={alt} loading="lazy" />,
        }), [onLocalArtifactOpen, hideLocalImages]);
  return (
    <div className={className ? `markdown-text ${className}` : "markdown-text"}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, remarkCjkEmphasis]} skipHtml
        urlTransform={(url) => resolveResourceUrl?.(url) ?? (localArtifactPath(url) ? url : defaultUrlTransform(url))}
        components={components}
      >{children}</ReactMarkdown>
    </div>
  );
}
