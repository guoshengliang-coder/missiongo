import { isAcceptedSessionUrl } from "@missiongo/domain";

import { sessionLinkLabelKey } from "./dispatch-eligibility";
import { useI18n } from "./i18n";

/**
 * The link to a dispatched session. The server already refuses anything else,
 * but the value was reported by a machine and lands in an `href`, so a link that
 * is not one of the two accepted shapes is not rendered at all.
 *
 * A Codex thread link hands off to the Codex app rather than a page, so it gets
 * no new tab.
 */
export function SessionLink({ url, compact = false }: { url: string; compact?: boolean }) {
  const { t } = useI18n();
  if (!isAcceptedSessionUrl(url)) return null;
  const labelKey = sessionLinkLabelKey(url);
  const label = compact ? t("agentConsoleClientView") : t(labelKey);
  return (
    <p className="dispatch-session-link">
      {labelKey === "dispatchOpenSession"
        ? <a className={compact ? "secondary-button" : undefined} href={url} target="_blank" rel="noopener noreferrer" title={t(labelKey)}>{label}</a>
        : <a className={compact ? "secondary-button" : undefined} href={url} title={t(labelKey)}>{label}</a>}
    </p>
  );
}
