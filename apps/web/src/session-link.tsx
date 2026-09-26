import { ExternalLink } from "lucide-react";

import { isAcceptedSessionUrl } from "@missiongo/domain";

import { sessionLinkLabelKey, sessionLinkTarget } from "./dispatch-eligibility";
import { useI18n } from "./i18n";

/**
 * The link to a dispatched session. The server already refuses anything else,
 * but the value was reported by a machine and lands in an `href`, so a link that
 * is not one of the two accepted shapes is not rendered at all.
 *
 * A Codex thread link hands off to the Codex app rather than a page, so it gets
 * no new tab.
 *
 * `mobile` is the one thing a phone changes (AND-214): the same button hands off
 * to the mobile client where one exists, and says where the session can really be
 * watched where none does. Callers that render it on a Mac leave it false.
 */
export function SessionLink({ url, compact = false, mobile = false }: { url: string; compact?: boolean; mobile?: boolean }) {
  const { t } = useI18n();
  if (!isAcceptedSessionUrl(url)) return null;
  const labelKey = sessionLinkLabelKey(url);
  const target = sessionLinkTarget(url, mobile);
  // On a phone the compact link is one of the head's icon buttons (AND-174):
  // the label stays in the DOM as the accessible name, the icon carries it
  // visually, and the stylesheet shows only one of the two at a time.
  const label = compact ? t("agentConsoleClientView") : t(labelKey);
  const content = compact
    ? <><ExternalLink className="dispatch-session-link-icon" size={16} aria-hidden />{label}</>
    : label;
  return (
    <p className="dispatch-session-link">
      {target.kind === "hint"
        // Nothing on this device can open it, so it is a note rather than a dead
        // link. The title still says where it opens, for a reader on a Mac.
        ? <span className="agent-session-muted" title={t(target.titleKey)}>{t(target.hintKey)}</span>
        : (
          <a
            className={compact ? "secondary-button" : undefined}
            href={target.href}
            {...(target.newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            title={t(labelKey)}
          >{content}</a>
        )}
    </p>
  );
}
