import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { MarkdownText } from "./markdown-text";
import { useI18n } from "./i18n";
import { localizedErrorText } from "./error-text";

/** Generic Markdown reading surface: render the persisted bytes, never a second summary. */
export function PlanDocumentPage({documentId}:{documentId:string}) {
  const {t}=useI18n();
  const query=useQuery({queryKey:["plan-document",documentId],queryFn:()=>api.getPlanDocument(documentId),retry:false});
  return <main className="artifact-document">
    <header className="artifact-toolbar">
      <button type="button" className="secondary-button" onClick={()=>{window.location.href="/";}}>{t("backToList")}</button>
      {query.data && <a className="secondary-button download-link" href={`/api/v1/plan-documents/${encodeURIComponent(documentId)}?download=1`} download>{t("download")}</a>}
    </header>
    {query.isPending && <p role="status">{t("loadingItems")}</p>}
    {query.isError && <div role="alert"><p>{localizedErrorText(query.error,t)}</p><button type="button" className="secondary-button" onClick={()=>void query.refetch()}>{t("retry")}</button></div>}
    {query.data && <><p>{query.data.rounds.map(r=>t("planDocumentRound",{key:r.key,round:r.number})).join(" / ")} · v{query.data.version}</p>
      <MarkdownText>{query.data.markdown}</MarkdownText></>}
  </main>;
}
