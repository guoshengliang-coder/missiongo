import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, LoaderCircle } from "lucide-react";
import { api, type StatusCheckRecord } from "./api";
import { localizedErrorText } from "./error-text";
import { useI18n } from "./i18n";
import { Modal } from "./modal";

const copy: Record<string,[string,string]> = {
  checked:["交接已核对","Handover checked"], waiting_node:["等待本机节点检查","Waiting for a local node"],
  checking:["正在检查","Checking"], waiting_merge:["等待核实 PR 合并","Waiting for merge evidence"],
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
function StatusCheckPanel({productId,itemKey,canOperate,onClose}:{productId:string;itemKey?:string;canOperate:boolean;onClose:()=>void}) {
  const {locale,t,statusLabel} = useI18n(); const zh = locale === "zh-CN";
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
  return <Modal title={zh ? "状态检查" : "Status checks"} subtitle={itemKey ?? product?.name ?? ""} onClose={onClose} wide scrolls>
    <p className="dispatch-note">{zh ? "已有证据由服务端核对；需要仓库权限时，由已关联的 macOS 节点检查。节点离线时任务会保留。" : "The server reconciles recorded evidence. Repository checks run on a mapped macOS node; offline work remains queued."}</p>
    {query.data?.schedule && <p className="dispatch-note">{query.data.schedule.time === false ? (zh ? "自动检查已关闭" : "Automatic checks disabled") : `${zh ? "每天" : "Daily at"} ${query.data.schedule.time} · ${query.data.schedule.timezone}`}</p>}
    <div className="status-check-actions"><button type="button" className="primary-button" disabled={!mayOperate || mutation.isPending} onClick={()=>mutation.mutate()}>
      {mutation.isPending ? <LoaderCircle className="spin" size={16}/> : <ClipboardCheck size={16}/>}{zh ? "立即检查并校正" : "Check and reconcile now"}</button>
      <button type="button" className="secondary-button" disabled={query.isFetching} onClick={()=>void refresh()}>{zh ? "刷新结果" : "Refresh results"}</button>
      {itemKey && mayOperate && canRegister && <button type="button" className="secondary-button" onClick={()=>setEditing(v=>!v)}>{zh ? "关联 PR / 确认发布范围" : "Associate PR / confirm release scope"}</button>}
    </div>
    {(mutation.isError || query.isError) && <p className="inline-error" role="alert">{localizedErrorText(mutation.error ?? query.error,t)}</p>}
    {requested && <p role="status" className="dispatch-note">{mutation.data?.missingAssociation ? (zh ? "缺少 PR 关联，暂时无法检查。请先关联 PR。" : "Associate a PR before requesting a check.")
      : mutation.data?.queued ? (zh ? "已排队，等待关联节点；这不代表已经核实。" : "Queued for a mapped node; this is not a verification result.")
      : (zh ? "已有证据已核对；请查看下方结果。" : "Recorded evidence reconciled; see results below.")}</p>}
    {editing && itemKey && <ScopeEditor key={newest?.id ?? itemKey} itemKey={itemKey} record={newest} artifacts={product?.releaseArtifacts ?? []} onSaved={async()=>{setEditing(false);await refresh();}}/>}
    {query.isLoading && <p><LoaderCircle className="spin" size={16}/>{zh ? "正在读取…" : "Loading…"}</p>}
    {query.isSuccess && !records.length && <p className="dispatch-note">{zh ? "暂无交接记录。未关联 PR 的条目无法自动推断合并或发布情况。" : "No handover recorded. Merge and release state cannot be inferred without a PR association."}</p>}
    <div className="status-check-list">{records.map(record=><article className="status-check-card" key={record.id}>
      <header><strong>{record.itemKey}</strong><span role="status">{statusCheckLabel(record.status,zh)}</span></header>
      <p>{zh ? "条目状态：" : "Item status: "}{statusLabel(record.itemStatus)}</p>
      <p><a href={record.pullRequestUrl} target="_blank" rel="noreferrer">{record.pullRequestUrl}</a></p>
      <p>{zh ? "发布范围：" : "Release scope: "}{record.requiredArtifacts === null ? (zh ? "待确认" : "Unconfirmed") : record.requiredArtifacts.length ? record.requiredArtifacts.join("、") : (zh ? "明确无需发布" : "Explicitly no release required")}</p>
      {record.noReleaseReason && <p>{record.noReleaseReason}</p>}
      {record.evidence.merged && <p>{zh ? "已核实合并：" : "Verified merge: "}<code>{record.evidence.merged.commit}</code> · {record.evidence.merged.occurredAt}</p>}
      {record.requiredArtifacts?.map(artifact=>{
        const release = record.evidence.releases?.find(r=>r.artifact === artifact);
        return <p key={artifact}><strong>{artifact}</strong> · {release ? `${release.version} · ${release.sourceCommit}` : (zh ? "尚无发布证据" : "No release evidence")}</p>;
      })}
      {zh && record.reason && <p className="dispatch-note">{record.reason}</p>}
      <p className="dispatch-note">{zh ? "来源：授权执行端上报；服务端未独立访问 GitHub。" : "Source: authorized executor report; GitHub is not independently checked by the server."}</p>
      <p className="dispatch-note">{zh ? "最近检查：" : "Last check: "}{record.checkedAt ? new Date(record.checkedAt).toLocaleString(locale) : (zh ? "尚未检查" : "Never")}</p>
    </article>)}</div>
    <div className="status-check-actions"><button type="button" className="secondary-button" disabled={offset === 0} onClick={()=>setOffset(Math.max(0,offset-100))}>{zh ? "上一页" : "Previous"}</button>
      <button type="button" className="secondary-button" disabled={query.data?.nextOffset === undefined} onClick={()=>setOffset(query.data!.nextOffset!)}>{zh ? "下一页" : "Next"}</button></div>
  </Modal>;
}
function ScopeEditor({itemKey,record,artifacts,onSaved}:{itemKey:string;record:StatusCheckRecord|undefined;artifacts:readonly string[];onSaved:()=>Promise<void>}) {
  const {locale,t} = useI18n(); const zh = locale === "zh-CN";
  const [url,setUrl] = useState(record?.pullRequestUrl ?? ""); const [selected,setSelected] = useState<string[]>(record?.requiredArtifacts ?? []);
  const [noRelease,setNoRelease] = useState(record?.requiredArtifacts?.length === 0); const [reason,setReason] = useState(record?.noReleaseReason ?? "");
  const mutation = useMutation({mutationFn:()=>api.registerHandover(itemKey,{pullRequestUrl:url.trim(),...(noRelease ? {requiredArtifacts:[],noReleaseReason:reason.trim()} : selected.length ? {requiredArtifacts:selected} : {})}),onSuccess:onSaved});
  return <form className="status-check-scope" onSubmit={event=>{event.preventDefault();mutation.mutate();}}>
    <label>{zh ? "PR 地址" : "PR URL"}<input type="url" required value={url} onChange={e=>setUrl(e.target.value)} maxLength={500}/></label>
    <fieldset><legend>{zh ? "本条需要发布的产物" : "Required release artifacts"}</legend>{artifacts.map(artifact=><label key={artifact}>
      <input type="checkbox" disabled={noRelease} checked={selected.includes(artifact)} onChange={e=>setSelected(e.target.checked ? [...selected,artifact] : selected.filter(a=>a!==artifact))}/>{artifact}</label>)}</fieldset>
    <label><input type="checkbox" checked={noRelease} onChange={e=>setNoRelease(e.target.checked)}/>{zh ? "明确无需发布" : "Explicitly no release required"}</label>
    {noRelease && <label>{zh ? "无需发布的依据和验证方式" : "Reason and verification method"}<textarea required value={reason} onChange={e=>setReason(e.target.value)} maxLength={4000}/></label>}
    {!noRelease && !selected.length && <p className="dispatch-note">{zh ? "未选产物表示范围未知，不会按无需发布处理。" : "No selection means unknown scope, not no release required."}</p>}
    {mutation.isError && <p className="inline-error" role="alert">{localizedErrorText(mutation.error,t)}</p>}
    <button type="submit" className="secondary-button" disabled={mutation.isPending}>{mutation.isPending && <LoaderCircle className="spin" size={16}/>} {zh ? "确认并保存关联" : "Confirm and save association"}</button>
  </form>;
}
