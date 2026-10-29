import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ItemDelivery, type ItemExecution } from "./api";
import type { Component, WorkItem } from "./types";
import { useSettingsDraft } from "./settings-drafts";
import { Modal } from "./modal";

// 「安排执行／交接」暂时隐藏：功能与后续流转还没定，入口先不出现。
// 改回 true 即可恢复按钮和弹窗；后端接口与执行记录展示不受影响。
const EXECUTION_ASSIGNMENT_ENABLED = false;

const executionLabels: Record<string,string> = {
  assigned:"待执行", working:"执行中", completed:"本轮完成", blocked:"受阻", cancelled:"已取消", handed_over:"已交接",
  active:"会话运行中", idle:"会话空闲", suspended:"会话已暂停", stalled:"会话停滞", unavailable:"会话不可用", failed:"执行失败", waiting_for_input:"等待输入",
};
function failure(error: unknown) { return error instanceof Error ? error.message : "操作失败，请刷新后重试。"; }

export function useItemDelivery(itemKey: string | null) {
  return useQuery({
    queryKey: ["delivery", itemKey],
    queryFn: () => api.getDelivery(itemKey!),
    enabled: Boolean(itemKey),
    refetchInterval: 15_000,
  });
}

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

/** 「转交负责人」从详情页的独立交付区块挪进了「更多」菜单，弹窗本身留在这里。 */
export function TransferBuilderModal({itemKey,delivery,onClose}: {itemKey:string;delivery:ItemDelivery;onClose:()=>void}) {
  const queryClient = useQueryClient();
  const [target,setTarget] = useState("");
  const [note,setNote] = useState("");
  const transfer = useMutation({
    mutationFn:()=>api.transferBuilder(itemKey,{accountId:target || null,expectedBuilderAccountId:delivery.builderAccountId,note}),
    onSuccess:async()=>{
      await Promise.all([
        queryClient.invalidateQueries({queryKey:["delivery",itemKey]}),queryClient.invalidateQueries({queryKey:["item",itemKey]}),
        queryClient.invalidateQueries({queryKey:["items"]}),queryClient.invalidateQueries({queryKey:["timeline",itemKey]}),
      ]);
      onClose();
    },
  });
  return <Modal title="转交负责人" subtitle="交付与执行" onClose={onClose}>
    <form className="delivery-form" onSubmit={event=>{event.preventDefault();transfer.mutate();}}>
      <label>新的 Builder<select aria-label="新的 Builder" required value={target} onChange={event=>setTarget(event.target.value)}><option value="">请选择负责人</option>{delivery.candidates.filter(account=>account.id!==delivery.builderAccountId).map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <label>交接说明<textarea required={Boolean(delivery.builderAccountId)} maxLength={2000} placeholder={delivery.builderAccountId ? undefined : "可不填，确认后默认记录「首次分配 builder」"} value={note} onChange={event=>setNote(event.target.value)} /></label>
      <small>转交整体交付责任，保留当前条目状态及执行安排。</small>
      {transfer.isError && <p role="alert">{failure(transfer.error)}</p>}
      <div className="form-footer">
        <button type="button" className="secondary-button" onClick={onClose}>取消</button>
        <button type="submit" className="primary-button" disabled={transfer.isPending || !target}>确认转交</button>
      </div>
    </form>
  </Modal>;
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
  const query=useItemDelivery(item.key);
  const [mode,setMode]=useState<"execution"|null>(null);
  const [scope,setScope]=useState("");const [performer,setPerformer]=useState("");const [previousId,setPreviousId]=useState("");const [executionNote,setExecutionNote]=useState("");
  const refresh=async()=>{await Promise.all([
    queryClient.invalidateQueries({queryKey:["delivery",item.key]}),queryClient.invalidateQueries({queryKey:["item",item.key]}),
    queryClient.invalidateQueries({queryKey:["items"]}),queryClient.invalidateQueries({queryKey:["timeline",item.key]}),
  ]);};
  const assign=useMutation({mutationFn:()=>api.assignExecution(item.key,{...(performer.startsWith("agent:") ? {kind:"agent" as const,sessionId:performer.slice(6)} : {kind:"human" as const,accountId:performer}),scope,...(previousId ? {previousId:previousId.replace(/^followup:/,""),followUp:previousId.startsWith("followup:"),note:executionNote} : {})}),onSuccess:async()=>{setMode(null);setScope("");setExecutionNote("");setPreviousId("");await refresh();}});
  const data=query.data;
  // Builder 与转交入口已收进标题行和「更多」菜单；这里只留下真实存在的执行记录，
  // 没有记录时不占任何空间（加载中或出错也不渲染）。
  if(!data) return null;
  const hasExecutions=data.executions.length>0;
  if(!hasExecutions && !EXECUTION_ASSIGNMENT_ENABLED) return null;
  return <section className="delivery-panel" aria-label={hasExecutions ? "执行记录" : "交付与执行"}>
    <div className="delivery-heading"><h3>{hasExecutions ? "执行记录" : "交付与执行"}</h3>
      {EXECUTION_ASSIGNMENT_ENABLED && data.canManage && <div className="delivery-actions">
        <button type="button" className="secondary-button" onClick={()=>{setPerformer("");setScope("");setPreviousId("");setExecutionNote("");assign.reset();setMode("execution");}}>安排执行／交接</button>
      </div>}
    </div>
    {EXECUTION_ASSIGNMENT_ENABLED && mode==="execution" && <Modal title="安排执行／交接" subtitle="交付与执行" onClose={()=>setMode(null)}>
      <form className="delivery-form" onSubmit={event=>{event.preventDefault();assign.mutate();}}>
        <label>执行人<select aria-label="执行人" required value={performer} onChange={event=>setPerformer(event.target.value)}><option value="">请选择执行人</option><optgroup label="人工账号">{data.performers.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</optgroup>
          <optgroup label="已关联 Agent 会话">{[...new Map(data.executions.filter(row=>row.kind==="agent" && row.sessionId).map(row=>[row.sessionId,row])).values()].map(row=><option key={row.sessionId} value={`agent:${row.sessionId}`}>{row.name} · {row.accountName} · {row.sessionId?.slice(0,8)}</option>)}</optgroup></select></label>
        <label>工作范围<textarea required maxLength={2000} value={scope} onChange={event=>setScope(event.target.value)} /></label>
        <label>执行方式<select aria-label="执行方式" value={previousId} onChange={event=>setPreviousId(event.target.value)}><option value="">新增执行安排（可并行）</option>{data.executions.map(row=>{const finished=["completed","cancelled","handed_over","failed"].includes(row.status);return <option key={row.id} value={finished ? `followup:${row.id}` : row.id}>{finished ? "后续／返工" : "接手"} {row.name}：{row.scope.slice(0,40)}</option>;})}</select></label>
        {previousId && <label>执行交接说明<textarea required maxLength={2000} value={executionNote} onChange={event=>setExecutionNote(event.target.value)} /></label>}
        <small>安排执行不改变 Builder，也不会停止正在运行的会话。Agent 使用现有派单和会话接入，关联后可选择并安排下一轮工作。</small>
        {assign.isError && <p role="alert">{failure(assign.error)}</p>}
        <div className="form-footer">
          <button type="button" className="secondary-button" onClick={()=>setMode(null)}>取消</button>
          <button type="submit" className="primary-button" disabled={assign.isPending || !performer || !scope.trim()}>确认安排</button>
        </div>
      </form>
    </Modal>}
    {hasExecutions
      ? <ol className="execution-list">{data.executions.map(execution=><ExecutionRow key={execution.id} execution={execution} delivery={data} itemKey={item.key} onRefresh={refresh} />)}</ol>
      : <p className="account-note">暂无执行记录。可安排多人并行执行，或在交接时新增下一轮记录。</p>}
  </section>;
}
