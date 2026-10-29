import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { localArtifactPath } from "@missiongo/domain";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/**
 * Render user-authored item text consistently. Raw HTML is deliberately
 * skipped: Markdown formatting is useful here, but item content must never
 * become executable or layout-controlling HTML.
 */
export function MarkdownText({ children, className, onLocalArtifactOpen, resolveResourceUrl }: { children: string; className?: string; onLocalArtifactOpen?: (href: string) => void; resolveResourceUrl?: (href: string) => string | undefined }) {
  return (
    <div className={className ? `markdown-text ${className}` : "markdown-text"}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} skipHtml
        urlTransform={(url) => resolveResourceUrl?.(url) ?? (localArtifactPath(url) ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) => href && localArtifactPath(href)
            ? onLocalArtifactOpen
              ? <button type="button" className="artifact-link" onClick={() => onLocalArtifactOpen(href)}>{children}</button>
              : <span>{children}</span>
            : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
          img: ({ src, alt }) => typeof src === "string" && localArtifactPath(src)
            ? onLocalArtifactOpen
              ? <button type="button" className="artifact-link" onClick={() => onLocalArtifactOpen(src)}>{alt || src.split("/").at(-1)}</button>
              : <span>{alt}</span>
            : <img src={src} alt={alt} loading="lazy" />,
        }}
      >{children}</ReactMarkdown>
    </div>
  );
}
