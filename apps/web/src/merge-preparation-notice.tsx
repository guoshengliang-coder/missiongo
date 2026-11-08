import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "./api";
import { localizedErrorText } from "./error-text";
import { useI18n } from "./i18n";
import { useDeliveries } from "./merge-console";
import { mergePreparationEvidence, type MergePreparationEvidence } from "./merge-preparation";
import type { AgentSession } from "./types";

function remembered(key: string) {
  try { return sessionStorage.getItem(`merge-preparation:${key}`) === "dismissed"; } catch { return false; }
}

export function MergePreparationNotice({ productId, session, evidence, blocked, send }: {
  productId: string; session: AgentSession; evidence: MergePreparationEvidence;
  blocked: boolean; send: (text: string) => Promise<unknown>;
}) {
  const { t } = useI18n(), client = useQueryClient(), deliveries = useDeliveries(productId);
  const choiceKey = ["merge-preparation-choice", evidence.key];
  const choice = useQuery({ queryKey: choiceKey, queryFn: () => remembered(evidence.key),
    initialData: () => remembered(evidence.key), staleTime: Infinity });
  const [checking, setChecking] = useState(false), [error, setError] = useState<string>();
  const lock = useRef(false);
  const dismiss = () => {
    try { sessionStorage.setItem(`merge-preparation:${evidence.key}`, "dismissed"); } catch { /* Query cache still retains this choice. */ }
    client.setQueryData(choiceKey, true);
  };
  const hasDelivery = (data: typeof deliveries.data) => Boolean(data?.attentionSessionIds?.includes(session.id)
    || data?.deliveries.some(d => d.sessionId === session.id && d.blocker !== "changed" && ["proposed", "confirmed"].includes(d.state)));
  const submit = async () => {
    if (lock.current || blocked || !session.canReply) return;
    lock.current = true; setChecking(true); setError(undefined);
    try {
      const [fresh, deliveryState] = await Promise.all([api.getAgentSession(session.id), deliveries.refetch()]);
      const current = mergePreparationEvidence(fresh);
      if (!fresh.canReply || !current || current.messageId !== evidence.messageId || current.text !== evidence.text
        || deliveryState.isError || hasDelivery(deliveryState.data)) {
        setError(t("mergePreparationChanged"));
        await client.invalidateQueries({ queryKey: ["agent-session", session.id] });
        return;
      }
      await send(t("mergePreparationInstruction", { commit: evidence.commit }));
      dismiss();
    } catch (cause) { setError(localizedErrorText(cause, t)); }
    finally { lock.current = false; setChecking(false); }
  };
  if (choice.data || !deliveries.isSuccess || hasDelivery(deliveries.data)) return null;
  return <section className="merge-delivery-notice proposed" role="status" aria-label={t("mergePreparationTitle")}>
    <span className="merge-delivery-icon" aria-hidden="true"><Plus size={18} /></span>
    <div className="merge-delivery-copy"><strong>{t("mergePreparationTitle")}</strong><p>{t("mergePreparationScope")}</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
    <div className="merge-delivery-choices">
      <button type="button" className="secondary-button" disabled={blocked || checking} onClick={dismiss}>{t("mergePreparationDecline")}</button>
      <button type="button" className="primary-button" disabled={blocked || checking || !session.canReply} onClick={() => void submit()}>
        {t(checking ? "mergePreparationSending" : "mergePreparationSubmit")}
      </button>
    </div>
  </section>;
}
