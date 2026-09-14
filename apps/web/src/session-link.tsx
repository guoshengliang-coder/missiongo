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
export function SessionLink({ url }: { url: string }) {
  const { t } = useI18n();
  if (!isAcceptedSessionUrl(url)) return null;
  const labelKey = sessionLinkLabelKey(url);
  return (
    <p className="dispatch-session-link">
      {labelKey === "dispatchOpenSession"
        ? <a href={url} target="_blank" rel="noopener noreferrer">{t(labelKey)}</a>
        : <a href={url}>{t(labelKey)}</a>}
    </p>
  );
}
