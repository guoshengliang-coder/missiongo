import { useMutation, useQuery } from "@tanstack/react-query";
import { request } from "./api";
import { localizedErrorText } from "./error-text";
import { useI18n } from "./i18n";

interface Review {
  reviewText: string;
  reviewDigest: string;
  confirmed: boolean;
  targetBranches: string[];
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
      {review.data.targetBranches.length > 0 && <p>{t("conversationIntegrationBranches", { branches: review.data.targetBranches.join(", ") })}</p>}
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{review.data.reviewText}</pre>
      {review.data.confirmed || confirm.data?.confirmed
        ? <p role="status">{t("conversationIntegrationConfirmed")}</p>
        : <button type="button" className="primary-button" disabled={confirm.isPending}
            onClick={() => confirm.mutate(review.data.reviewDigest)}>{t("conversationIntegrationConfirm")}</button>}
    </>}
  </main>;
}
