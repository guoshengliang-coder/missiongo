import { useMutation, useQuery } from "@tanstack/react-query";
import { Bot, CirclePause, LoaderCircle, Rocket, UserRound } from "lucide-react";

import { api } from "./api";
import { aiAvailability, productAllowsAi, type AiAvailability } from "./dispatch-eligibility";
import { useI18n, type MessageKey } from "./i18n";
import type { Product, TransitionAction, WorkItem } from "./types";

const CLAIM: TransitionAction = { label: "Start work", to: "in_progress", reason: "claim", tone: "primary" };

const UNAVAILABLE_KEYS: Readonly<Record<Extract<AiAvailability, { kind: "not_configured" }>["reason"], MessageKey>> = {
  no_nodes: "startWorkAiNoNodes",
  repo_unmapped: "startWorkAiRepoUnmapped",
  offline: "startWorkAiOffline",
  agent_unavailable: "startWorkAiAgentMissing",
};

/**
 * "Start work" on a ready item asks how (AND-68): a person picks it up now, or
 * it goes to an AI agent on one of this account's machines.
 *
 * Accounts without AI permission only see the ordinary human workflow. Once
 * permission exists, a missing device/repository/agent is shown as a disabled
 * choice with a route to Agent management, because that is configuration the
 * account holder can fix.
 *
 * Picking the AI does not dispatch from here: it opens the dispatch dialog the
 * list already uses, so machine, agent and mode are chosen in one place.
 */
export function StartWorkDialog({
  item,
  product,
  onClose,
  onClaimed,
  onDispatch,
  onOpenAgents,
}: {
  readonly item: WorkItem;
  readonly product: Product | undefined;
  readonly onClose: () => void;
  readonly onClaimed: (updated: WorkItem) => void;
  readonly onDispatch: () => void;
  readonly onOpenAgents: () => void;
}) {
  const { t } = useI18n();
  // Only asked when it matters: an account without the permission is not told
  // anything about its machines.
  const mayUseAi = productAllowsAi(product);
  const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes, enabled: mayUseAi });
  const availability = aiAvailability(product, nodesQuery.isError ? [] : nodesQuery.data?.nodes);
  const claim = useMutation({
    mutationFn: () => api.transitionItem(item.key, CLAIM),
    onSuccess: onClaimed,
  });

  return (
    <div className="start-work">
      <button
        type="button"
        className="start-work-choice"
        data-initial-focus
        disabled={claim.isPending}
        onClick={() => claim.mutate()}
      >
        {claim.isPending ? <LoaderCircle className="spin" size={20} /> : <UserRound size={20} />}
        <span>
          <strong>{t("startWorkManual")}</strong>
          <small>{t("startWorkManualHelp")}</small>
        </span>
      </button>

      {mayUseAi && (
        <>
          <button
            type="button"
            className="start-work-choice"
            disabled={availability.kind !== "available" || claim.isPending}
            onClick={onDispatch}
          >
            {availability.kind === "checking" ? <LoaderCircle className="spin" size={20} /> : <Rocket size={20} />}
            <span>
              <strong>{t("startWorkAi")}</strong>
              <small>{t("startWorkAiHelp")}</small>
            </span>
          </button>

          {availability.kind === "not_configured" && (
            <div className="start-work-unavailable" role="note">
              <strong>{t("startWorkAiUnsupported")}</strong>
              <p>{t(UNAVAILABLE_KEYS[availability.reason])}</p>
              <button type="button" className="text-button" onClick={onOpenAgents}>
                <Bot size={15} /> {t("agentManagementEntry")}
              </button>
            </div>
          )}
        </>
      )}

      {claim.isError && (
        <div className="inline-error"><CirclePause size={16} /><span>{claim.error instanceof Error ? claim.error.message : t("somethingWentWrong")}</span></div>
      )}

      <div className="form-footer">
        <button type="button" className="secondary-button" onClick={onClose}>{t("cancel")}</button>
      </div>
    </div>
  );
}
