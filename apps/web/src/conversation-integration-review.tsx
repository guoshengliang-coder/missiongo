import { useMutation, useQuery } from "@tanstack/react-query";
import { request } from "./api";
import { localizedErrorText } from "./error-text";
import { useI18n } from "./i18n";

interface Review {
  reviewText: string;
  reviewDigest: string;
  confirmed: boolean;
  targetBranches: string[];
  sessionId?: string;
  productId?: string;
  operation?: "merge_only" | "merge_and_publish" | "publish_only";
  merges?: Array<{ repository: string; pullRequest: number; title: string }>;
  artifacts?: string[];
  blockers?: string[];
  publicationTargets?: Array<{ artifact: string; version?: string }>;
  releaseCandidates?: Array<{ identity: string; title: string; artifacts: string[]; note?: string }>;
  confirmationBlocker?: string;
}

export function ConversationIntegrationReview({ preparationId }: { preparationId: string }) {
  const { t } = useI18n();
  const path = `/api/v1/conversation-integrations/${encodeURIComponent(preparationId)}/review`;
  const review = useQuery({ queryKey: ["conversation-integration-review", preparationId], queryFn: () => request<Review>(path), retry: false });
  const confirm = useMutation({
    mutationFn: (reviewDigest: string) => request<{ confirmed: boolean }>(path, { method: "POST", body: JSON.stringify({ reviewDigest }) }),
    onSettled: () => void review.refetch(),
  });
  const error = review.error ?? confirm.error;
  return <main className="artifact-document">
    <header className="artifact-toolbar">
      <a className="secondary-button" href="/">{t("backToList")}</a>
    </header>
    {review.isPending && <p role="status">{t("loadingItems")}</p>}
    {error && <p role="alert">{localizedErrorText(error, t)}</p>}
    {review.data && <>
      {review.data.sessionId && <p><a className="secondary-button" href={`/?${new URLSearchParams({
        console: "agent", session: review.data.sessionId, ...(review.data.productId ? { product: review.data.productId } : {}),
      })}`}>{t("conversationIntegrationReturn")}</a></p>}
      {review.data.targetBranches.length > 0 && <p>{t("conversationIntegrationBranches", { branches: review.data.targetBranches.join(", ") })}</p>}
      {review.data.operation && <h1>{t(`conversationIntegrationAction_${review.data.operation}`)}</h1>}
      {Boolean(review.data.merges?.length) && <ul>{review.data.merges?.map(target =>
        <li key={`${target.repository}/pull/${target.pullRequest}`}>PR #{target.pullRequest} · {target.title}</li>)}</ul>}
      {Boolean(review.data.artifacts?.length) && <p>{t("conversationIntegrationArtifacts", { artifacts: review.data.artifacts!.join(", ") })}</p>}
      {Boolean(review.data.releaseCandidates?.length) && <ul>{review.data.releaseCandidates?.map(candidate =>
        <li key={candidate.identity}>{candidate.title}{candidate.artifacts.length > 0 ? ` · ${candidate.artifacts.join(", ")}` : ""}{candidate.note && <p>{candidate.note}</p>}</li>)}</ul>}
      {review.data.publicationTargets?.some(target => target.version) && <p>{t("conversationIntegrationVersions", {
        versions: review.data.publicationTargets.filter(target => target.version).map(target => `${target.artifact} ${target.version}`).join(", "),
      })}</p>}
      {review.data.confirmationBlocker && <p role="alert">{review.data.confirmationBlocker}</p>}
      {Boolean(review.data.blockers?.length) && <ul>{review.data.blockers?.map(blocker => <li key={blocker}>{blocker}</li>)}</ul>}
      {review.data.operation
        ? <details><summary>{t("conversationIntegrationDetails")}</summary>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{review.data.reviewText}</pre></details>
        : <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{review.data.reviewText}</pre>}
      {review.data.confirmed || confirm.data?.confirmed
        ? <p role="status">{t("conversationIntegrationConfirmed")}</p>
        : <button type="button" className="primary-button" disabled={confirm.isPending || Boolean(review.data.confirmationBlocker)}
            onClick={() => confirm.mutate(review.data.reviewDigest)}>{t("conversationIntegrationConfirm")}</button>}
    </>}
  </main>;
}
