import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useSettingsDraft } from "./settings-drafts";
import { ModuleBuilderSetting } from "./item-delivery";

function failure(error: unknown) { return error instanceof Error ? error.message : "加载失败，请重试。"; }

/** Role assignments are separate from ordinary product capabilities. */
export function ProjectAdministratorsSettings({productId}: {productId:string}) {
  const client = useQueryClient();
  const accounts = useQuery({queryKey:["accounts"],queryFn:api.listAccounts});
  const query = useQuery({queryKey:["project-administrators",productId],queryFn:()=>api.listProjectAdministrators(productId)});
  const [selected,setSelected] = useState<string[]>([]);
  useEffect(()=>{if(query.data) setSelected(query.data.accountIds);},[query.data]);
  const changed = JSON.stringify([...selected].sort()) !== JSON.stringify([...(query.data?.accountIds ?? [])].sort());
  const save = useMutation({mutationFn:()=>api.setProjectAdministrators(productId,selected,query.data!.accountIds),onSuccess:async data=>{
    client.setQueryData(["project-administrators",productId],data);
    await Promise.all([client.invalidateQueries({queryKey:["products"]}),client.invalidateQueries({queryKey:["accounts"]}),client.invalidateQueries({queryKey:["product-access",productId]})]);
  }});
  useSettingsDraft(changed,save.isPending);
  if(query.isPending || accounts.isPending) return <p role="status">正在加载项目管理员…</p>;
  if(query.isError || accounts.isError) return <p role="alert">{failure(query.error ?? accounts.error)}</p>;
  return <section aria-label="项目管理员配置" className="project-administrators-settings">
    <p className="settings-hub-intro">由系统管理员授予。项目管理员可以查看本项目、配置模块默认 Builder，并为所有条目分配或转交 Builder。支持设置多名项目管理员。</p>
    <p className="account-note">此角色不授予系统账号管理、执行安排或 AI 操作权限。取消角色后，账号原有的产品权限仍然保留。</p>
    <fieldset disabled={save.isPending} className="project-administrator-choices"><legend>选择本项目的管理员</legend>
      {accounts.data.accounts.map(account=><label key={account.id} className="project-administrator-choice">
        <input type="checkbox" checked={selected.includes(account.id)} disabled={Boolean(account.disabledAt) && !selected.includes(account.id)} onChange={event=>setSelected(event.target.checked ? [...selected,account.id] : selected.filter(id=>id!==account.id))} />
        <span><strong>{account.nickname || account.email}</strong>{account.nickname && <small>{account.email}</small>}<small>{account.disabledAt ? "已停用，角色不生效" : account.role === "admin" ? "系统管理员，已拥有所有项目的 Builder 管理权限" : "普通账号"}</small></span>
      </label>)}
    </fieldset>
    <div className="account-form-actions"><button type="button" className="secondary-button" disabled={!changed || save.isPending} onClick={() => setSelected(query.data.accountIds)}>取消</button><button type="button" className="primary-button" disabled={!changed || save.isPending} onClick={()=>save.mutate()}>保存项目管理员</button></div>
    {save.isError && <p role="alert">{failure(save.error)}</p>}
    {save.isSuccess && !changed && <p role="status">项目管理员已保存</p>}
  </section>;
}

export function ProjectBuilderSettings({productId}: {productId:string}) {
  const query = useQuery({queryKey:["components",productId],queryFn:()=>api.listComponents(productId)});
  return <section aria-label="模块 Builder 分配">
    <p className="settings-hub-intro">为各来源模块配置默认 Builder，新条目将自动分配给对应负责人。已有条目的 Builder 可在条目详情中转交。</p>
    {query.isPending ? <p role="status">正在加载模块…</p> : query.isError ? <p role="alert">{failure(query.error)}</p> : query.data.length ?
      <div className="project-builder-modules">{query.data.map(component=><section key={component.id} className="project-builder-module"><h2>{component.name}</h2><ModuleBuilderSetting component={component} /></section>)}</div> : <p className="account-note">暂无来源模块，请先在模块管理中创建。</p>}
  </section>;
}
