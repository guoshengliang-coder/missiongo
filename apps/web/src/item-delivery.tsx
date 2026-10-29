import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ItemDelivery, type ItemExecution } from "./api";
import type { Component, WorkItem } from "./types";
import { useSettingsDraft } from "./settings-drafts";

const executionLabels: Record<string,string> = {
  assigned:"待执行", working:"执行中", completed:"本轮完成", blocked:"受阻", cancelled:"已取消", handed_over:"已交接",
  active:"会话运行中", idle:"会话空闲", suspended:"会话已暂停", stalled:"会话停滞", unavailable:"会话不可用", failed:"执行失败", waiting_for_input:"等待输入",
};
function failure(error: unknown) { return error instanceof Error ? error.message : "操作失败，请刷新后重试。"; }

export function ModuleBuilderSetting({component}: {component: Component}) {
  const queryClient = useQueryClient();
  const builders = useQuery({queryKey:["builders",component.productId],queryFn:()=>api.listBuilders(component.productId)});
  const [id,setId] = useState(component.defaultBuilderAccountId ?? "");
  useEffect(()=>setId(component.defaultBuilderAccountId ?? ""),[component.defaultBuilderAccountId]);
  const save = useMutation({mutationFn:()=>api.setModuleBuilder(component.productId,component.id,id || null),onSuccess:()=>queryClient.invalidateQueries({queryKey:["components",component.productId]})});
  const changed = id !== (component.defaultBuilderAccountId ?? "");
  useSettingsDraft(changed,save.isPending);
  return <div className="module-builder-setting">
    <label>默认 Builder<select aria-label={`${component.name} 默认 Builder`} value={id} disabled={!builders.data?.canConfigure || Boolean(component.archivedAt) || save.isPending} onChange={event=>setId(event.target.value)}>
      <option value="">未配置</option>{builders.data?.builders.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}
      {id && !builders.data?.builders.some(account=>account.id===id) && <option value={id}>原负责人已不可用，请重新分配</option>}
    </select></label>
    {changed && <button type="button" className="secondary-button" disabled={save.isPending || !builders.data?.canConfigure} onClick={()=>save.mutate()}>保存默认 Builder</button>}
    <small>用于新条目自动分配，不改变已有条目的负责人。</small>
    {(save.isError || builders.isError) && <p role="alert">{failure(save.error ?? builders.error)}</p>}
  </div>;
}

function ExecutionRow({execution,delivery,itemKey,onRefresh}: {execution: ItemExecution;delivery:ItemDelivery;itemKey:string;onRefresh:()=>Promise<unknown>}) {
  const [status,setStatus]=useState("working"); const [result,setResult]=useState("");
  const mutation=useMutation({mutationFn:()=>api.updateExecution(itemKey,execution.id,status,result),onSuccess:onRefresh});
  const finished=["completed","cancelled","handed_over","failed"].includes(execution.status);
  const editable=!finished && (execution.kind==="human" || execution.recorded===true) && (delivery.canManage || delivery.currentAccountId===execution.accountId);
  return <li className="execution-row">
    <div className="execution-heading"><strong>{execution.name}</strong><span>{execution.kind==="agent" ? "Agent" : "人工"} · {executionLabels[execution.status] ?? execution.status}</span></div>
    <p>{execution.scope}</p>
    {execution.previousId && <small>接续执行：{delivery.executions.find(row=>row.id===execution.previousId)?.name ?? "历史执行"}</small>}
    <small>安排：{new Date(execution.createdAt).toLocaleString("zh-CN")}{execution.startedAt ? ` · 开始：${new Date(execution.startedAt).toLocaleString("zh-CN")}` : ""}{execution.endedAt ? ` · 结束：${new Date(execution.endedAt).toLocaleString("zh-CN")}` : ""}</small>
    {execution.kind==="agent" && <small>授权账号：{execution.accountName} · 会话：<code>{execution.sessionId}</code> · {execution.sessionStatus ? `会话状态：${executionLabels[execution.sessionStatus] ?? execution.sessionStatus} · ` : ""}执行结果以会话记录为准</small>}
    {execution.result && <p className="execution-result">{execution.result}</p>}
    {editable && <details><summary>更新本轮执行</summary><form className="delivery-form" onSubmit={event=>{event.preventDefault();mutation.mutate();}}>
      <label>执行状态<select value={status} onChange={event=>setStatus(event.target.value)} aria-label={`${execution.name} 执行状态`}>
        <option value="working">执行中</option><option value="completed">本轮完成</option><option value="blocked">受阻</option><option value="cancelled">取消本轮执行</option>
      </select></label>
      <label>结果／说明<textarea maxLength={2000} value={result} onChange={event=>setResult(event.target.value)} required={status!=="working"} /></label>
      <button className="secondary-button" disabled={mutation.isPending}>保存执行进展</button>
      {mutation.isError && <p role="alert">{failure(mutation.error)}</p>}
    </form></details>}
  </li>;
}

export function ItemDeliveryPanel({item}: {item:WorkItem}) {
  const queryClient=useQueryClient();
  const query=useQuery({queryKey:["delivery",item.key],queryFn:()=>api.getDelivery(item.key),refetchInterval:15_000});
  const [mode,setMode]=useState<"builder"|"execution"|null>(null);
  const [target,setTarget]=useState("");const [note,setNote]=useState("");
  const [scope,setScope]=useState("");const [performer,setPerformer]=useState("");const [previousId,setPreviousId]=useState("");
  const refresh=async()=>{await Promise.all([
    queryClient.invalidateQueries({queryKey:["delivery",item.key]}),queryClient.invalidateQueries({queryKey:["item",item.key]}),
    queryClient.invalidateQueries({queryKey:["items"]}),queryClient.invalidateQueries({queryKey:["timeline",item.key]}),
  ]);};
  const transfer=useMutation({mutationFn:()=>api.transferBuilder(item.key,{accountId:target || null,expectedBuilderAccountId:query.data?.builderAccountId ?? null,note}),onSuccess:async()=>{setMode(null);setNote("");await refresh();}});
  const assign=useMutation({mutationFn:()=>api.assignExecution(item.key,{...(performer.startsWith("agent:") ? {kind:"agent" as const,sessionId:performer.slice(6)} : {kind:"human" as const,accountId:performer}),scope,...(previousId ? {previousId:previousId.replace(/^followup:/,""),followUp:previousId.startsWith("followup:"),note} : {})}),onSuccess:async()=>{setMode(null);setScope("");setNote("");setPreviousId("");await refresh();}});
  if(query.isPending) return <section className="delivery-panel" aria-label="交付与执行"><p>正在加载交付信息…</p></section>;
  if(query.isError) return <section className="delivery-panel"><p role="alert">{failure(query.error)}</p><button type="button" className="secondary-button" onClick={()=>query.refetch()}>重试</button></section>;
  const data=query.data;
  return <section className="delivery-panel" aria-label="交付与执行">
    <div className="delivery-heading"><div><h3>交付与执行</h3><p>Builder：<strong>{data.builderName ?? "待分配"}</strong>{data.builderNeedsReassignment && <span role="status"> · 需重新分配</span>}</p></div>
      {data.canManage && <div className="delivery-actions">
        <button type="button" className="secondary-button" onClick={()=>{setMode(mode==="builder"?null:"builder");setTarget(data.builderAccountId ?? "");setNote("");transfer.reset();}}>转交负责人</button>
        <button type="button" className="secondary-button" onClick={()=>{setMode(mode==="execution"?null:"execution");setNote("");assign.reset();}}>安排执行／交接</button>
      </div>}
    </div>
    {mode==="builder" && <form className="delivery-form" onSubmit={event=>{event.preventDefault();transfer.mutate();}}>
      <label>新的 Builder<select aria-label="新的 Builder" required value={target} onChange={event=>setTarget(event.target.value)}><option value="">请选择负责人</option>{data.candidates.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <label>交接说明<textarea required maxLength={2000} value={note} onChange={event=>setNote(event.target.value)} /></label>
      <small>转交整体交付责任，保留当前条目状态及执行安排。</small>
      <button className="secondary-button" disabled={transfer.isPending || !target || target===data.builderAccountId}>确认转交</button>
      {transfer.isError && <p role="alert">{failure(transfer.error)}</p>}
    </form>}
    {mode==="execution" && <form className="delivery-form" onSubmit={event=>{event.preventDefault();assign.mutate();}}>
      <label>执行人<select aria-label="执行人" required value={performer} onChange={event=>setPerformer(event.target.value)}><option value="">请选择执行人</option><optgroup label="人工账号">{data.performers.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</optgroup>
        <optgroup label="已关联 Agent 会话">{[...new Map(data.executions.filter(row=>row.kind==="agent" && row.sessionId).map(row=>[row.sessionId,row])).values()].map(row=><option key={row.sessionId} value={`agent:${row.sessionId}`}>{row.name} · {row.accountName} · {row.sessionId?.slice(0,8)}</option>)}</optgroup></select></label>
      <label>工作范围<textarea required maxLength={2000} value={scope} onChange={event=>setScope(event.target.value)} /></label>
      <label>执行方式<select aria-label="执行方式" value={previousId} onChange={event=>setPreviousId(event.target.value)}><option value="">新增执行安排（可并行）</option>{data.executions.map(row=>{const finished=["completed","cancelled","handed_over","failed"].includes(row.status);return <option key={row.id} value={finished ? `followup:${row.id}` : row.id}>{finished ? "后续／返工" : "接手"} {row.name}：{row.scope.slice(0,40)}</option>;})}</select></label>
      {previousId && <label>执行交接说明<textarea required maxLength={2000} value={note} onChange={event=>setNote(event.target.value)} /></label>}
      <small>安排执行不改变 Builder，也不会停止正在运行的会话。Agent 使用现有派单和会话接入，关联后可选择并安排下一轮工作。</small>
      <button className="secondary-button" disabled={assign.isPending || !performer || !scope.trim()}>确认安排</button>
      {assign.isError && <p role="alert">{failure(assign.error)}</p>}
    </form>}
    <p className="account-note">本轮执行完成与条目交付状态分别记录。</p>
    {data.executions.length ? <ol className="execution-list">{data.executions.map(execution=><ExecutionRow key={execution.id} execution={execution} delivery={data} itemKey={item.key} onRefresh={refresh} />)}</ol> : <p className="account-note">暂无执行记录。可安排多人并行执行，或在交接时新增下一轮记录。</p>}
  </section>;
}
