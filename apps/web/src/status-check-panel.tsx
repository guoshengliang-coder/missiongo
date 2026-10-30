import { useDialogDraft } from "./dialog-state";
import type { CompletionReference } from "@missiongo/contracts";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, LoaderCircle } from "lucide-react";
import { api, type StatusCheckRecord } from "./api";
import { localizedErrorText } from "./error-text";
import { useI18n } from "./i18n";
import { Modal } from "./modal";

const copy: Record<string,[string,string]> = {
  checked:["交接已核对","Handover checked"], waiting_node:["等待本机节点检查","Waiting for a local node"],
  waiting_confirmation:["等待人工确认","Waiting for human confirmation"],
  checking:["正在检查","Checking"], waiting_merge:["等待核实集成","Waiting for merge evidence"],
  waiting_release:["等待必需产物发布","Waiting for required releases"], needs_scope:["待确认发布范围","Release scope needs confirmation"],
  evidence_missing:["缺少可信证据","Evidence missing"], permission_failed:["本机仓库权限不足","Repository permission required on the node"],
  failed:["检查失败，可重试","Check failed; retry available"], stale:["处理轮次已变化，旧记录失效","Old record invalidated by a new work round"],
};
export function statusCheckLabel(status: string, chinese: boolean) { return copy[status]?.[chinese ? 0 : 1] ?? (chinese ? "尚未核实" : "Not verified"); }

export function StatusCheckButton({productId,itemKey,canOperate}:{productId:string;itemKey?:string;canOperate:boolean}) {
  const {locale} = useI18n(); const [open,setOpen] = useState(false);
  return <><button type="button" className={itemKey ? "icon-button" : "secondary-button status-check-entry"} aria-label={locale === "zh-CN" ? "检查状态" : "Check status"} title={locale === "zh-CN" ? "检查状态" : "Check status"} onClick={()=>setOpen(true)}><ClipboardCheck size={16}/>{!itemKey && <span className="status-check-entry-label">{locale === "zh-CN" ? "检查状态" : "Check status"}</span>}</button>
    {open && <StatusCheckPanel key={itemKey ?? productId} productId={productId} {...(itemKey ? {itemKey} : {})} canOperate={canOperate} onClose={()=>setOpen(false)}/>}</>;
}
export function StatusCheckPanel({productId,itemKey,canOperate,onClose}:{productId:string;itemKey?:string;canOperate:boolean;onClose:()=>void}) {
  const {locale,t,statusLabel} = useI18n(); const zh = locale === "zh-CN";
  const [confirmation, setConfirmation] = useState<StatusCheckRecord | null>(null);
  const [scopeRecord, setScopeRecord] = useState<StatusCheckRecord>();
  const [offset,setOffset] = useState(0); const [editing,setEditing] = useState(false); const [requested,setRequested] = useState(false);
  const client = useQueryClient();
  const products = useQuery({queryKey:["products"],queryFn:()=>api.listProducts()});
  const product = products.data?.find(p=>p.id === productId);
  const item = useQuery({queryKey:["item",itemKey],queryFn:()=>api.getItem(itemKey!),enabled:Boolean(itemKey)});
  const canRegister = Boolean(item.data && ["in_progress","development_complete"].includes(item.data.status));
  const mayOperate = canOperate && product?.access?.canOperate !== false && products.isSuccess;
  const query = useQuery({queryKey:["status-checks",productId,itemKey,offset],queryFn:()=>api.statusChecks(productId,itemKey,offset),
    refetchInterval: q => q.state.data?.items.some(r=>["waiting_node","checking"].includes(r.status)) ? 5000 : false});
  const refresh = async () => { await Promise.all([client.invalidateQueries({queryKey:["status-checks"]}),client.invalidateQueries({queryKey:["items"]}),client.invalidateQueries({queryKey:["item"]}),client.invalidateQueries({queryKey:["timeline"]})]); };
  const mutation = useMutation({mutationFn:()=>api.requestStatusCheck(productId,itemKey),onSuccess:async()=>{setRequested(true);await refresh();}});
  const records = query.data?.items ?? [];
  const newest = records[0];
  const statusFingerprint = records.map(r=>`${r.itemKey}:${r.itemStatus}`).join("|");
  useEffect(()=>{
    if (!statusFingerprint) return;
    void client.invalidateQueries({queryKey:["items"]});
    void client.invalidateQueries({queryKey:["item"]});
    void client.invalidateQueries({queryKey:["timeline"]});
  },[statusFingerprint,client]);
  return <Modal title={editing ? (zh ? "关联完成依据 / 确认发布范围" : "Associate completion / confirm release scope") : confirmation ? (zh ? "人工确认交付" : "Confirm delivery") : (zh ? "状态检查" : "Status checks")} subtitle={itemKey ?? product?.name ?? ""} onClose={onClose} pending={mutation.isPending} wide scrolls>
    {editing && itemKey ? <ScopeEditor key={itemKey} itemKey={itemKey} record={scopeRecord} artifacts={product?.releaseArtifacts ?? []} onCancel={()=>setEditing(false)} onSaved={async()=>{setEditing(false);await refresh();}}/>
      : confirmation ? <HumanConfirmation key={`${confirmation.id}:${confirmation.itemStatus}`} record={confirmation} onCancel={()=>setConfirmation(null)} onSaved={async()=>{setConfirmation(null);await refresh();}}/> : <>
    <p className="dispatch-note">{zh ? "已有证据由服务端核对；需要仓库权限时，由已关联的 macOS 节点检查。节点离线时任务会保留。" : "The server reconciles recorded evidence. Repository checks run on a mapped macOS node; offline work remains queued."}</p>
    {query.data?.schedule && <p className="dispatch-note">{query.data.schedule.time === false ? (zh ? "自动检查已关闭" : "Automatic checks disabled") : `${zh ? "每天" : "Daily at"} ${query.data.schedule.time} · ${query.data.schedule.timezone}`}</p>}
    <div className="status-check-actions"><button type="button" className="primary-button" disabled={!mayOperate || mutation.isPending} onClick={()=>mutation.mutate()}>
      {mutation.isPending ? <LoaderCircle className="spin" size={16}/> : <ClipboardCheck size={16}/>}{zh ? "立即检查并校正" : "Check and reconcile now"}</button>
      <button type="button" className="secondary-button" disabled={query.isFetching} onClick={()=>void refresh()}>{zh ? "刷新结果" : "Refresh results"}</button>
      {itemKey && mayOperate && canRegister && <button type="button" className="secondary-button" onClick={()=>{setScopeRecord(newest);setEditing(true);}}>{zh ? "关联完成依据 / 确认发布范围" : "Associate completion / confirm release scope"}</button>}
    </div>
    {(mutation.isError || query.isError) && <p className="inline-error" role="alert">{localizedErrorText(mutation.error ?? query.error,t)}</p>}
    {requested && <p role="status" className="dispatch-note">{mutation.data?.missingAssociation ? (zh ? "缺少完成依据，暂时无法检查。请先关联 PR、MR 或提交。" : "Associate a PR, MR or commit before requesting a check.")
      : mutation.data?.queued ? (zh ? "已排队，等待关联节点；这不代表已经核实。" : "Queued for a mapped node; this is not a verification result.")
      : (zh ? "已有证据已核对；请查看下方结果。" : "Recorded evidence reconciled; see results below.")}</p>}

    {query.isLoading && <p><LoaderCircle className="spin" size={16}/>{zh ? "正在读取…" : "Loading…"}</p>}
    {query.isSuccess && !records.length && <p className="dispatch-note">{zh ? "暂无交接记录。请先关联完成依据和发布范围。" : "No handover recorded. Associate completion evidence and release scope first."}</p>}
    <div className="status-check-list">{records.map(record=><article className="status-check-card" key={record.id}>
      <header><strong>{record.itemKey}</strong><span role="status">{statusCheckLabel(record.status,zh)}</span></header>
      <p>{zh ? "条目状态：" : "Item status: "}{statusLabel(record.itemStatus)}</p>
      <p>{"url" in record.completion ? <a href={record.completion.url} target="_blank" rel="noreferrer">{record.completion.kind === "gitlab" ? "GitLab MR" : "GitHub PR"} · {record.completion.url}</a>
        : <>{record.completion.kind === "commit" ? (zh ? "本地提交" : "Local commit") : (zh ? "人工确认" : "Human confirmation")} · <code>{record.completion.commit}</code>{record.completion.kind === "commit" && ` → ${record.completion.targetBranch}`}</>}</p>
      <p>{zh ? "发布范围：" : "Release scope: "}{record.requiredArtifacts === null ? (zh ? "待确认" : "Unconfirmed") : record.requiredArtifacts.length ? record.requiredArtifacts.join("、") : (zh ? "明确无需发布" : "Explicitly no release required")}</p>
      {record.noReleaseReason && <p>{record.noReleaseReason}</p>}
      {record.evidence.merged && <p>{zh ? "已核实集成：" : "Verified integration: "}<code>{record.evidence.merged.commit}</code> · {record.evidence.merged.occurredAt}</p>}
      {record.requiredArtifacts?.map(artifact=>{
        const release = record.evidence.releases?.find(r=>r.artifact === artifact);
        return <p key={artifact}><strong>{artifact}</strong> · {release ? `${release.version} · ${release.sourceCommit}` : (zh ? "尚无发布证据" : "No release evidence")}</p>;
      })}
      {record.evidenceReporter?.accountId && record.evidenceSource === "human_confirmation" && <p>{zh ? "确认人：" : "Confirmed by: "}{record.evidenceReporter.accountId} · {record.evidenceReporter.recordedAt}</p>}
      {record.evidenceReporter?.note && <p>{record.evidenceReporter.note}</p>}
      {zh && record.reason && <p className="dispatch-note">{record.reason}</p>}
      <p className="dispatch-note">{record.evidenceSource === "human_confirmation" ? (zh ? "来源：登录用户人工确认。" : "Source: signed-in user's confirmation.") : (zh ? "来源：授权执行端上报；服务端未独立访问代码托管平台。" : "Source: authorized executor report; the server does not independently check the repository host.")}</p>
      {mayOperate && ["in_progress","development_complete"].includes(record.itemStatus) && record.status !== "stale" &&
        <button type="button" className="secondary-button" disabled={record.requiredArtifacts === null} onClick={()=>setConfirmation(record)}>{record.itemStatus === "in_progress" ? (zh ? "人工确认已集成" : "Confirm integration") : record.requiredArtifacts?.length === 0 ? (zh ? "安排人工验证" : "Arrange verification") : (zh ? "人工确认已发布" : "Confirm publication")}</button>}
      <p className="dispatch-note">{zh ? "最近检查：" : "Last check: "}{record.checkedAt ? new Date(record.checkedAt).toLocaleString(locale) : (zh ? "尚未检查" : "Never")}</p>
    </article>)}</div>
    <div className="status-check-actions"><button type="button" className="secondary-button" disabled={offset === 0} onClick={()=>setOffset(Math.max(0,offset-100))}>{zh ? "上一页" : "Previous"}</button>
      <button type="button" className="secondary-button" disabled={query.data?.nextOffset === undefined} onClick={()=>setOffset(query.data!.nextOffset!)}>{zh ? "下一页" : "Next"}</button></div>
    </>}
  </Modal>;
}
function ScopeEditor({itemKey,record,artifacts,onSaved,onCancel}:{itemKey:string;record:StatusCheckRecord|undefined;artifacts:readonly string[];onSaved:()=>Promise<void>;onCancel:()=>void}) {
  const {locale,t} = useI18n(); const zh = locale === "zh-CN";
  const [kind,setKind] = useState<CompletionReference["kind"]>(record?.completion.kind ?? "github");
  const [url,setUrl] = useState(record?.pullRequestUrl ?? "");
  const [commit,setCommit] = useState(record && "commit" in record.completion ? record.completion.commit : "");
  const [branch,setBranch] = useState(record?.completion.kind === "commit" ? record.completion.targetBranch : "main");
  const [description,setDescription] = useState(record?.completion.kind === "manual" ? record.completion.description : ""); const [selected,setSelected] = useState<string[]>(record?.requiredArtifacts ?? []);
  const [noRelease,setNoRelease] = useState(record?.requiredArtifacts?.length === 0); const [reason,setReason] = useState(record?.noReleaseReason ?? "");
  const mutation = useMutation({mutationFn:()=>api.registerHandover(itemKey,{completion: kind === "github" || kind === "gitlab" ? {kind,url:url.trim()} : kind === "commit" ? {kind,commit:commit.trim(),targetBranch:branch.trim()} : {kind,commit:commit.trim(),description:description.trim()},...(noRelease ? {requiredArtifacts:[],noReleaseReason:reason.trim()} : selected.length ? {requiredArtifacts:selected} : {})}),onSuccess:onSaved});
  const currentDraft = JSON.stringify({kind,url,commit,branch,description,selected,noRelease,reason});
  const [initialDraft] = useState(currentDraft);
  useDialogDraft(currentDraft !== initialDraft, mutation.isPending);
  return <form className="status-check-scope" onSubmit={event=>{event.preventDefault();mutation.mutate();}}>
    <label>{zh ? "完成依据" : "Completion reference"}<select value={kind} onChange={e=>setKind(e.target.value as CompletionReference["kind"])}>
      <option value="github">GitHub PR</option><option value="gitlab">GitLab MR</option>
      <option value="commit">{zh ? "本地 Git 提交" : "Local Git commit"}</option><option value="manual">{zh ? "人工确认" : "Human confirmation"}</option></select></label>
    {kind === "github" || kind === "gitlab" ? <label>{kind === "github" ? "PR URL" : "MR URL"}<input type="url" required value={url} onChange={e=>setUrl(e.target.value)} maxLength={500}/></label>
      : <label>{zh ? "完整提交编号" : "Full commit SHA"}<input required pattern="[a-f0-9]{40}" value={commit} onChange={e=>setCommit(e.target.value)} maxLength={40}/></label>}
    {kind === "commit" && <label>{zh ? "集成的目标分支" : "Integration target branch"}<input required value={branch} onChange={e=>setBranch(e.target.value)} maxLength={200}/></label>}
    {kind === "manual" && <label>{zh ? "需要人工确认的交付说明" : "Delivery details for human confirmation"}<textarea required value={description} onChange={e=>setDescription(e.target.value)} maxLength={4000}/></label>}
    <fieldset><legend>{zh ? "本条需要发布的产物" : "Required release artifacts"}</legend>{artifacts.map(artifact=><label key={artifact}>
      <input type="checkbox" disabled={noRelease} checked={selected.includes(artifact)} onChange={e=>setSelected(e.target.checked ? [...selected,artifact] : selected.filter(a=>a!==artifact))}/>{artifact}</label>)}</fieldset>
    <label><input type="checkbox" checked={noRelease} onChange={e=>setNoRelease(e.target.checked)}/>{zh ? "明确无需发布" : "Explicitly no release required"}</label>
    {noRelease && <label>{zh ? "无需发布的依据和验证方式" : "Reason and verification method"}<textarea required value={reason} onChange={e=>setReason(e.target.value)} maxLength={4000}/></label>}
    {!noRelease && !selected.length && <p className="dispatch-note">{zh ? "未选产物表示范围未知，不会按无需发布处理。" : "No selection means unknown scope, not no release required."}</p>}
    {mutation.isError && <p className="inline-error" role="alert">{localizedErrorText(mutation.error,t)}</p>}
    <div className="form-footer"><button type="button" className="secondary-button" disabled={mutation.isPending} onClick={onCancel}>{t("cancel")}</button><button type="submit" className="primary-button" disabled={mutation.isPending}>{mutation.isPending && <LoaderCircle className="spin" size={16}/>} {zh ? "确认并保存关联" : "Confirm and save association"}</button></div>
  </form>;
}

function HumanConfirmation({record,onSaved,onCancel}:{record:StatusCheckRecord;onSaved:()=>Promise<void>;onCancel:()=>void}) {
  const {locale,t} = useI18n(); const zh = locale === "zh-CN";
  const stage = record.itemStatus === "in_progress" ? "integration" : "release";
  const [commit,setCommit] = useState("commit" in record.completion ? record.completion.commit : record.evidence.merged?.commit ?? "");
  const [note,setNote] = useState("");
  const [details,setDetails] = useState<Record<string,{version:string;sourceCommit:string}>>({});
  const noRelease = record.requiredArtifacts?.length === 0;
  const mutation = useMutation({mutationFn:()=>api.confirmHandover(record.itemKey,record.id,stage === "integration" ? {stage,commit:commit.trim(),note:note.trim()}
    : {stage,note:note.trim(),releases:(record.requiredArtifacts ?? []).map(artifact=>({artifact,version:details[artifact]?.version.trim() ?? "",sourceCommit:details[artifact]?.sourceCommit.trim() ?? ""}))}),onSuccess:async()=>{await onSaved();}});
  const label = stage === "integration" ? (zh ? "人工确认已集成" : "Confirm integration") : noRelease ? (zh ? "安排人工验证" : "Arrange verification") : (zh ? "人工确认已发布" : "Confirm publication");
  useDialogDraft(Boolean(note) || Object.keys(details).length > 0 || commit !== ("commit" in record.completion ? record.completion.commit : record.evidence.merged?.commit ?? ""), mutation.isPending);
  return <form className="status-check-scope" onSubmit={e=>{e.preventDefault();if (!mutation.isPending) mutation.mutate();}}>
      <p className="dispatch-note">{zh ? "确认会记录你的账号和说明，不代表验收通过。" : "Your account and explanation will be recorded. This does not pass acceptance."}</p>
      {stage === "integration" ? <label>{zh ? "已纳入交付的完整提交编号" : "Integrated commit SHA"}<input required pattern="[a-f0-9]{40}" value={commit} onChange={e=>setCommit(e.target.value)} maxLength={40}/></label>
        : record.requiredArtifacts?.map(artifact=><fieldset className="status-check-release-fields" key={artifact}><legend>{artifact}</legend>
          <label>{zh ? "发布版本" : "Published version"}<input required maxLength={100} value={details[artifact]?.version ?? ""} onChange={e=>setDetails(d=>({...d,[artifact]:{sourceCommit:d[artifact]?.sourceCommit ?? "",version:e.target.value}}))}/></label>
          <label>{zh ? "发布来源的完整提交编号" : "Published source commit SHA"}<input required pattern="[a-f0-9]{40}" maxLength={40} value={details[artifact]?.sourceCommit ?? ""} onChange={e=>setDetails(d=>({...d,[artifact]:{version:d[artifact]?.version ?? "",sourceCommit:e.target.value}}))}/></label>
        </fieldset>)}
      <label>{zh ? "确认依据与说明" : "Evidence and explanation"}<textarea required maxLength={2000} value={note} onChange={e=>setNote(e.target.value)}/></label>
      {mutation.isError && <p className="inline-error" role="alert">{localizedErrorText(mutation.error,t)}</p>}
      <div className="form-footer"><button type="button" className="secondary-button" disabled={mutation.isPending} onClick={onCancel}>{t("cancel")}</button><button type="submit" className="primary-button" disabled={mutation.isPending}>{label}</button></div>
    </form>;
}
