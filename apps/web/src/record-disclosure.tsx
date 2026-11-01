import type { ReactNode } from "react";

/** Native disclosure keeps the whole header keyboard and touch accessible. */
export function RecordDisclosure({ className, summary, children }: { className: string; summary: ReactNode; children: ReactNode }) {
  return <details className={className}>
    <summary>
      <span className="record-summary">{summary}</span>
      <span className="record-toggle"><span className="when-closed">展开</span><span className="when-open">收起</span></span>
    </summary>
    {children}
  </details>;
}
