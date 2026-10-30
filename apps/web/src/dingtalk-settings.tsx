import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DingTalkBinding, DingTalkBindingInput, DingTalkNotification, DingTalkNotificationStatus, DingTalkImportRow, DingTalkImportPreview } from "@missiongo/domain";
import { api } from "./api";
import { useSettingsDraft } from "./settings-drafts";
import { parseDingTalkCsv } from "./dingtalk-csv";
import { Modal } from "./modal";

const failure=(error:unknown)=>error instanceof Error?error.message:"操作失败，请重试。";
const statusLabels:Record<DingTalkNotificationStatus,string>={queued:"等待发送",sending:"正在发送",accepted:"已受理，待确认结果",sent:"发送成功",failed:"发送失败",skipped:"未发送",uncertain:"发送结果不明"};
function NotificationState({notice}:{notice:DingTalkNotification}) {
  return <span className="dingtalk-notice-state"><strong>{statusLabels[notice.status]}</strong>{notice.reason && <small>{notice.reason}</small>}</span>;
}
function IntegrationForm() {
  const client=useQueryClient();
  const query=useQuery({queryKey:["dingtalk-settings"],queryFn:api.dingtalkSettings});
  const [corpId,setCorpId]=useState("");const [clientId,setClientId]=useState("");const [agentId,setAgentId]=useState("");const [secret,setSecret]=useState("");
  useEffect(()=>{if(query.data){setCorpId(query.data.corpId);setClientId(query.data.clientId);setAgentId(query.data.agentId);setSecret("");}},[query.data?.revision]);
  const dirty=Boolean(query.data && (corpId!==query.data.corpId || clientId!==query.data.clientId || agentId!==query.data.agentId || secret));
  const save=useMutation({mutationFn:()=>api.saveDingtalkSettings({corpId,clientId,agentId,...(secret?{clientSecret:secret}:{}),expectedRevision:query.data!.revision}),onSuccess:async data=>{setSecret("");client.setQueryData(["dingtalk-settings"],data);await client.invalidateQueries({queryKey:["dingtalk-project"]});}});
  const check=useMutation({mutationFn:api.checkDingtalk});
  useSettingsDraft(dirty,save.isPending || check.isPending);
  if(query.isPending)return <p role="status">正在加载钉钉配置…</p>;
  if(query.isError)return <p role="alert">{failure(query.error)}</p>;
  return <section className="dingtalk-section"><h2>组织与应用</h2>
    <p className="account-note">由同一组织的企业内部应用发送个人工作通知。应用可使用范围应覆盖接收人，不需要聊天机器人或通讯录查询权限。</p>
    <form className="dingtalk-form" onSubmit={event=>{event.preventDefault();check.reset();save.mutate();}}>
      <fieldset disabled={save.isPending} className="dingtalk-fields">
        <label>组织 ID（CorpId）<input required maxLength={100} value={corpId} onChange={event=>setCorpId(event.target.value)} /></label>
        <label>Client ID（AppKey）<input required maxLength={100} value={clientId} onChange={event=>setClientId(event.target.value)} autoComplete="off" /></label>
        <label>Agent ID<input required inputMode="numeric" pattern="[0-9]+" maxLength={100} value={agentId} onChange={event=>setAgentId(event.target.value)} /></label>
        <label>Client Secret（AppSecret）<input type="password" autoComplete="new-password" maxLength={512} value={secret} placeholder={query.data.configured?"已配置；留空保留原密钥":"请输入应用密钥"} required={!query.data.configured} onChange={event=>setSecret(event.target.value)} /></label>
      </fieldset>
      <p className="account-note">配置保存在服务器，密钥加密保存。更换组织前需解除现有人员绑定。</p>
      <div className="account-form-actions"><button className="secondary-button" type="button" disabled={!query.data.configured || dirty || check.isPending || save.isPending} onClick={()=>check.mutate()}>检查应用凭据</button><button className="primary-button" disabled={!dirty || save.isPending}>{save.isPending?"正在保存…":"保存钉钉配置"}</button></div>
      {save.isError && <p role="alert">{failure(save.error)}</p>}{save.isSuccess && !dirty && <p role="status">钉钉配置已保存。</p>}
      {check.isError && <p role="alert">{failure(check.error)}</p>}{check.isSuccess && !dirty && <p role="status">应用凭据可用。组织 ID、Agent ID 与接收人范围请在钉钉后台核对，并通过测试通知验证。</p>}
    </form>
  </section>;
}
export function DingTalkBindingEditor({accountId,email,binding,test,disabled=false}:{accountId:string;email:string;binding:DingTalkBinding|undefined;test:DingTalkNotification|undefined;disabled?:boolean}) {
  const client=useQueryClient();
  const [draft,setDraft]=useState<DingTalkBindingInput>({userId:binding?.userId??"",name:binding?.name??"",department:binding?.department??""});
  useEffect(()=>{setDraft({userId:binding?.userId??"",name:binding?.name??"",department:binding?.department??""});},[binding?.revision]);
  const dirty=draft.userId!==(binding?.userId??"") || draft.name!==(binding?.name??"") || draft.department!==(binding?.department??"");
  const refresh=()=>client.invalidateQueries({queryKey:["dingtalk-bindings"]});
  const save=useMutation({mutationFn:(remove:boolean)=>api.saveDingtalkBinding(accountId,remove?null:draft,binding?.revision??null),onSuccess:refresh});
  const sendTest=useMutation({mutationFn:()=>api.testDingtalkBinding(accountId),onSuccess:refresh});
  useSettingsDraft(dirty,save.isPending || sendTest.isPending);
  const change=(field:keyof DingTalkBindingInput,value:string)=>setDraft({...draft,[field]:value});
  return <details className="dingtalk-binding"><summary><span><strong>{email}</strong><small>{binding?`${binding.name||binding.userId}${binding.department?` · ${binding.department}`:""}`:"未绑定"}{disabled?" · 账号已停用":""}</small></span><span>{binding?"修改绑定":"配置绑定"}</span></summary>
    <form className="dingtalk-form" onSubmit={event=>{event.preventDefault();save.mutate(false);}}>
      <fieldset className="dingtalk-fields" disabled={save.isPending}>
        <label>钉钉企业用户 ID（userId）<input required maxLength={100} value={draft.userId} onChange={event=>change("userId",event.target.value)} /></label>
        <label>钉钉姓名（选填）<input maxLength={100} value={draft.name} onChange={event=>change("name",event.target.value)} /></label>
        <label>部门（选填）<input maxLength={200} value={draft.department} onChange={event=>change("department",event.target.value)} /></label>
      </fieldset>
      <small>需填写企业内 userId。邮箱、手机号和客户端展示的钉钉号不能替代它。手动填写的姓名与部门仅供核对。</small>
      <div className="account-form-actions">
        {binding && <button type="button" className="secondary-button" disabled={save.isPending || sendTest.isPending} onClick={()=>save.mutate(true)}>解除绑定</button>}
        <button type="button" className="secondary-button" disabled={!binding || dirty || disabled || sendTest.isPending || save.isPending} onClick={()=>sendTest.mutate()}>发送测试通知</button>
        <button className="primary-button" disabled={!dirty || save.isPending}>保存人员绑定</button>
      </div>
      {save.isError && <p role="alert">{failure(save.error)}</p>}{sendTest.isError && <p role="alert">{failure(sendTest.error)}</p>}
      {save.isSuccess && !dirty && <p role="status">人员绑定已保存。</p>}
      {test && <NotificationState notice={test} />}
    </form>
  </details>;
}
function BindingImport() {
  const client=useQueryClient();const [csv,setCsv]=useState("");const [error,setError]=useState("");
  const currentSource=useRef(csv);currentSource.current=csv;
  const [preview,setPreview]=useState<{data:DingTalkImportPreview;rows:DingTalkImportRow[]}|null>(null);
  const check=useMutation({mutationFn:async()=>{const source=csv,rows=parseDingTalkCsv(source);return {source,rows,data:await api.previewDingtalkBindings(rows)};},onSuccess:result=>{if(result.source===currentSource.current)setPreview(result);}});
  const commit=useMutation({mutationFn:()=>api.importDingtalkBindings(preview!.rows,preview!.data.fingerprint),onSuccess:async()=>{setCsv("");setPreview(null);await client.invalidateQueries({queryKey:["dingtalk-bindings"]});}});
  useSettingsDraft(Boolean(csv),check.isPending || commit.isPending);
  const setSource=(value:string)=>{setCsv(value);setPreview(null);setError("");check.reset();commit.reset();};
  return <details className="dingtalk-section"><summary>批量导入人员绑定</summary>
    <p className="account-note">按邮箱匹配已有 MissionGo 账号。最多 500 行，先预览再确认；已有账号的绑定会被所确认的内容替换。</p>
    <div className="dingtalk-form">
      <label>选择 CSV 文件<input type="file" accept=".csv,text/csv" disabled={commit.isPending} onChange={async event=>{const file=event.target.files?.[0];event.target.value="";if(!file)return;if(file.size>256_000){setError("文件超过 256 KB，请分批导入。");return;}try{setSource(await file.text());}catch{setError("文件读取失败。");}}} /></label>
      <label>CSV 内容<textarea aria-label="CSV 内容" rows={5} maxLength={256000} value={csv} disabled={commit.isPending} placeholder={"邮箱,钉钉用户 ID,姓名,部门\nperson@example.test,employee-id,姓名,部门"} onChange={event=>setSource(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}{check.isError && <p role="alert">{failure(check.error)}</p>}{commit.isError && <p role="alert">{failure(commit.error)}</p>}
      {!preview && <button type="button" className="secondary-button" disabled={!csv.trim() || check.isPending} onClick={()=>check.mutate()}>预览匹配结果</button>}
      {preview && <><ol className="dingtalk-import-preview">{preview.data.rows.map((row,index)=><li key={index}><strong>{row.email}</strong><span>{row.userId} · {row.name} · {row.department}</span><small>{row.issue??"匹配成功，将保存此绑定"}</small></li>)}</ol>
        <button type="button" className="primary-button" disabled={preview.data.rows.some(row=>row.issue) || commit.isPending} onClick={()=>commit.mutate()}>确认导入 {preview.data.rows.length} 条绑定</button></>}
      {commit.isSuccess && <p role="status">人员绑定已导入。</p>}
    </div>
  </details>;
}
export function DingTalkSettingsPage() {
  const accounts=useQuery({queryKey:["accounts"],queryFn:api.listAccounts});
  const bindings=useQuery({queryKey:["dingtalk-bindings"],queryFn:api.dingtalkBindings,refetchInterval:5000});
  const [search,setSearch]=useState("");
  return <div className="dingtalk-settings"><IntegrationForm /><section className="dingtalk-section"><h2>人员绑定</h2>
    <p className="account-note">管理员统一维护，不需要用户自行授权。保存后按账号绑定，修改登录邮箱不会丢失关联。</p>
    <label>搜索人员<input type="search" value={search} onChange={event=>setSearch(event.target.value)} placeholder="邮箱、姓名或部门" /></label>
    {accounts.isPending || bindings.isPending?<p role="status">正在加载人员…</p>:accounts.isError || bindings.isError?<p role="alert">{failure(accounts.error??bindings.error)}</p>:
      <div className="dingtalk-binding-list">{accounts.data.accounts.filter(account=>{const binding=bindings.data.bindings.find(value=>value.accountId===account.id);return [account.email,account.nickname,binding?.name,binding?.department].some(value=>value?.toLowerCase().includes(search.toLowerCase()));}).map(account=><DingTalkBindingEditor key={account.id} accountId={account.id} email={account.email} disabled={Boolean(account.disabledAt)} binding={bindings.data.bindings.find(value=>value.accountId===account.id)} test={bindings.data.tests[account.id]} />)}</div>}
  </section><BindingImport /></div>;
}
export function DingTalkProjectSettings({productId}:{productId:string}) {
  const client=useQueryClient();const query=useQuery({queryKey:["dingtalk-project",productId],queryFn:()=>api.dingtalkProject(productId)});
  const [enabled,setEnabled]=useState(false);useEffect(()=>{if(query.data)setEnabled(query.data.enabled);},[query.data?.enabled]);
  const save=useMutation({mutationFn:()=>api.saveDingtalkProject(productId,enabled,query.data!.enabled),onSuccess:data=>client.setQueryData(["dingtalk-project",productId],data)});
  useSettingsDraft(Boolean(query.data && enabled!==query.data.enabled),save.isPending);
  if(query.isPending)return <p role="status">正在加载通知配置…</p>;
  if(query.isError)return <p role="alert">{failure(query.error)}</p>;
  return <section className="dingtalk-section"><h2>待验证通知</h2><p className="account-note">进入待验证时，通过钉钉个人工作通知提醒提需者；开启后不补发历史条目。</p>
    {!query.data.integrationConfigured && <p role="status">钉钉应用尚未配置，请联系系统管理员。</p>}
    <label className="project-administrator-choice"><input type="checkbox" checked={enabled} disabled={!query.data.canConfigure || save.isPending} onChange={event=>setEnabled(event.target.checked)} /><span>进入待验证时通知提需者</span></label>
    <p className="account-note">接收人须由管理员在“管理设置 → 钉钉集成”中绑定，且具有本项目查看权限。条目详情中可查看发送结果和未发送原因。</p>
    {query.data.canConfigure && <div className="account-form-actions"><button type="button" className="primary-button" disabled={enabled===query.data.enabled || save.isPending} onClick={()=>save.mutate()}>保存通知设置</button></div>}
    {save.isError && <p role="alert">{failure(save.error)}</p>}{save.isSuccess && enabled===query.data.enabled && <p role="status">通知设置已保存。</p>}
  </section>;
}
export function ItemDingTalkNotifications({itemKey,pending}:{itemKey:string;pending:boolean}) {
  const client=useQueryClient();const query=useQuery({queryKey:["dingtalk-notifications",itemKey],queryFn:()=>api.dingtalkNotifications(itemKey),refetchInterval:5000});
  const [confirm,setConfirm]=useState<string|null>(null);
  const retry=useMutation({mutationFn:(id:string)=>api.retryDingtalkNotification(itemKey,id),onSuccess:data=>{setConfirm(null);client.setQueryData(["dingtalk-notifications",itemKey],data);}});
  if(query.isError)return <p role="alert">钉钉通知记录加载失败，请刷新重试。</p>;
  if(!query.data?.notifications.length)return null;
  return <details className="dingtalk-item-notices"><summary>钉钉通知 · {statusLabels[query.data.notifications[0]!.status]}</summary><ol className="dingtalk-import-preview">{query.data.notifications.map((notice,index)=><li key={notice.id}>
    <NotificationState notice={notice} /><small>{new Date(notice.createdAt).toLocaleString()} · 已尝试 {notice.attempts} 次</small>
    {index===0 && pending && query.data.canRetry && ["failed","skipped","uncertain"].includes(notice.status) && <button type="button" className="secondary-button" disabled={retry.isPending} onClick={()=>notice.status==="uncertain"?setConfirm(notice.id):retry.mutate(notice.id)}>补发通知</button>}
  </li>)}</ol>{retry.isError && <p role="alert">{failure(retry.error)}</p>}
    {confirm && <Modal title="确认补发通知" subtitle="此前发送结果不明" onClose={()=>setConfirm(null)} pending={retry.isPending}><p>此前消息可能已送达。请先核实接收情况，补发可能产生重复通知。</p><div className="form-footer"><button type="button" className="secondary-button" onClick={()=>setConfirm(null)} disabled={retry.isPending}>取消</button><button type="button" className="primary-button" onClick={()=>retry.mutate(confirm)} disabled={retry.isPending}>已核实，补发通知</button></div></Modal>}
  </details>;
}
