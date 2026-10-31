import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DingTalkDeliveryMode, DingTalkSettings, DingTalkBinding, DingTalkBindingInput, DingTalkNotification, DingTalkNotificationStatus, DingTalkImportRow, DingTalkImportPreview } from "@missiongo/domain";
import { api } from "./api";
import { useSettingsDraft } from "./settings-drafts";
import { parseDingTalkCsv } from "./dingtalk-csv";
import { Modal } from "./modal";
import { Select } from "./select";

const failure = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试。";
const statusLabels: Record<DingTalkNotificationStatus, string> = { queued: "等待发送", sending: "正在发送", accepted: "已受理，待确认结果", sent: "发送成功", failed: "发送失败", skipped: "未发送", uncertain: "发送结果不明" };
const inProgress = (notice: DingTalkNotification | undefined) => Boolean(notice && ["queued", "sending", "accepted"].includes(notice.status));
const deliveryLabel = (mode: DingTalkDeliveryMode) => mode === "robot" ? "机器人单聊通知" : "个人工作通知";

function NotificationState({ notice }: { notice: DingTalkNotification }) {
  return <span className="dingtalk-notice-state"><strong>{statusLabels[notice.status]}</strong>{notice.reason && <small>{notice.reason}</small>}</span>;
}

// Route cancellation through Modal so unsaved drafts get the same protection
// from the footer button, Escape, the backdrop and browser back.
function CancelDialogButton({ label = "取消" }: { label?: string }) {
  return <button type="button" className="secondary-button" onClick={event => {
    event.currentTarget.closest("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true }));
  }}>{label}</button>;
}

function ApplicationInfo({ settings }: { settings: DingTalkSettings }) {
  return <dl className="dingtalk-info-grid">
    <div><dt>通知方式</dt><dd>{deliveryLabel(settings.deliveryMode)}</dd></div>
    <div><dt>组织 ID（CorpId）</dt><dd>{settings.corpId || "未配置"}</dd></div>
    <div><dt>Client ID（AppKey）</dt><dd>{settings.clientId || "未配置"}</dd></div>
    {settings.deliveryMode === "robot" ? <div><dt>机器人编码（robotCode）</dt><dd>{settings.robotCode || "未配置"}</dd></div> : <div><dt>Agent ID</dt><dd>{settings.agentId || "未配置"}</dd></div>}
    <div><dt>Client Secret（AppSecret）</dt><dd>{settings.configured ? "已配置" : "未配置"}</dd></div>
  </dl>;
}

function IntegrationEditor({ settings, onClose, onSaved }: { settings: DingTalkSettings; onClose: () => void; onSaved: () => void }) {
  const client = useQueryClient();
  // Keep the revision that the administrator opened. A background refresh must
  // neither reset their edits nor silently authorize overwriting newer values.
  const [original] = useState(settings);
  const [corpId, setCorpId] = useState(original.corpId);
  const [clientId, setClientId] = useState(original.clientId);
  const [agentId, setAgentId] = useState(original.agentId);
  const [deliveryMode, setDeliveryMode] = useState<DingTalkDeliveryMode>(original.deliveryMode);
  const [robotCode, setRobotCode] = useState(original.robotCode);
  const [secret, setSecret] = useState("");
  const dirty = corpId !== original.corpId || clientId !== original.clientId || agentId !== original.agentId || deliveryMode !== original.deliveryMode || robotCode !== original.robotCode || Boolean(secret);
  const save = useMutation({
    mutationFn: () => api.saveDingtalkSettings({ corpId, clientId, agentId, deliveryMode, robotCode, ...(secret ? { clientSecret: secret } : {}), expectedRevision: original.revision }),
    onSuccess: async data => {
      setSecret("");
      client.setQueryData(["dingtalk-settings"], data);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["dingtalk-project"] }),
        client.invalidateQueries({ queryKey: ["dingtalk-bindings"] }),
      ]);
      onSaved();
    },
  });
  return <Modal title={original.configured ? "修改钉钉配置" : "配置钉钉应用"} subtitle="组织与应用" onClose={onClose} dirty={dirty} pending={save.isPending}>
    <form className="dialog-form" onSubmit={event => { event.preventDefault(); if (!save.isPending) save.mutate(); }}>
      <label>通知方式<Select aria-label="通知方式" value={deliveryMode} onChange={event => setDeliveryMode(event.target.value as DingTalkDeliveryMode)}><option value="robot">机器人单聊通知</option><option value="work_notice">个人工作通知</option></Select></label>
      <label>组织 ID（CorpId）<input required maxLength={100} value={corpId} onChange={event => setCorpId(event.target.value)} /></label>
      <label>Client ID（AppKey）<input required maxLength={100} value={clientId} onChange={event => setClientId(event.target.value)} autoComplete="off" /></label>
      {deliveryMode === "robot" ? <label>机器人编码（robotCode）<input required maxLength={100} value={robotCode} onChange={event => setRobotCode(event.target.value)} placeholder="填写钉钉后台显示的 robotCode" autoComplete="off" /></label> : <label>Agent ID<input required inputMode="numeric" pattern="[0-9]+" maxLength={100} value={agentId} onChange={event => setAgentId(event.target.value)} /></label>}
      <label>Client Secret（AppSecret）<input type="password" autoComplete="new-password" maxLength={512} value={secret} placeholder={original.configured ? "已配置；留空保留原密钥" : "请输入应用密钥"} required={!original.configured} onChange={event => setSecret(event.target.value)} /></label>
      <p className="account-note">填写同一组织、同一企业内部应用的凭据。密钥加密保存在服务器；更换组织前需解除现有人员绑定。</p>
      {deliveryMode === "robot" && <p className="account-note">在钉钉开放平台为此应用启用机器人，开通“企业内机器人发送消息权限”，并发布机器人及应用。此处仅发送单向通知，不接入聊天问答。机器人名称和头像在钉钉后台设置。</p>}
      {save.isError && <p role="alert">{failure(save.error)}</p>}
      <div className="form-footer"><CancelDialogButton /><button className="primary-button" disabled={!dirty || save.isPending}>{save.isPending ? "正在保存…" : "保存钉钉配置"}</button></div>
    </form>
  </Modal>;
}

function CredentialCheckDialog({ settings, onClose }: { settings: DingTalkSettings; onClose: () => void }) {
  const check = useMutation({ mutationFn: api.checkDingtalk });
  return <Modal title="检查应用凭据" subtitle="组织与应用" onClose={onClose} pending={check.isPending}>
    <div className="dialog-form">
      <ApplicationInfo settings={settings} />
      <p className="account-note">此检查只验证应用访问凭据。请通过人员测试通知，进一步确认{settings.deliveryMode === "robot" ? "机器人编码、发送权限" : "Agent ID"}、用户 ID 与应用可使用范围。</p>
      {check.isError && <p role="alert">{failure(check.error)}</p>}
      {check.isSuccess && <p role="status">应用凭据可用。请继续发送人员测试通知，确认实际送达。</p>}
      <div className="form-footer"><CancelDialogButton label="关闭" /><button type="button" className="primary-button" disabled={check.isPending} onClick={() => check.mutate()}>{check.isPending ? "正在检查…" : "检查应用凭据"}</button></div>
    </div>
  </Modal>;
}

function IntegrationSummary() {
  const query = useQuery({ queryKey: ["dingtalk-settings"], queryFn: api.dingtalkSettings });
  const [dialog, setDialog] = useState<"edit" | "check" | null>(null);
  const [saved, setSaved] = useState(false);
  if (query.isPending) return <p role="status">正在加载钉钉配置…</p>;
  if (query.isError) return <p role="alert">{failure(query.error)}</p>;
  return <section className="dingtalk-section">
    <div className="dingtalk-section-heading"><h2>组织与应用</h2><div className="dingtalk-actions">
      <button type="button" className="secondary-button" disabled={!query.data.configured} onClick={() => setDialog("check")}>检查应用凭据</button>
      <button type="button" className="secondary-button" onClick={() => { setSaved(false); setDialog("edit"); }}>{query.data.configured ? "修改配置" : "配置应用"}</button>
    </div></div>
    <p className="account-note">{query.data.deliveryMode === "robot" ? "以企业内部应用机器人的身份，在个人单聊会话中发送系统通知。" : "通过企业内部应用发送个人工作通知；如需机器人会话，请在“修改配置”中切换通知方式。"}应用可使用范围须覆盖接收人。</p>
    <ApplicationInfo settings={query.data} />
    {saved && <p role="status">钉钉配置已保存。</p>}
    {dialog === "edit" && <IntegrationEditor settings={query.data} onClose={() => setDialog(null)} onSaved={() => { setSaved(true); setDialog(null); }} />}
    {dialog === "check" && <CredentialCheckDialog key={query.data.revision} settings={query.data} onClose={() => setDialog(null)} />}
  </section>;
}

function BindingEditorDialog({ accountId, email, binding, onClose, onSaved }: { accountId: string; email: string; binding: DingTalkBinding | undefined; onClose: () => void; onSaved: (removed: boolean) => void }) {
  const client = useQueryClient();
  const [original] = useState(binding);
  const [draft, setDraft] = useState<DingTalkBindingInput>({ userId: original?.userId ?? "", name: original?.name ?? "", department: original?.department ?? "" });
  const [confirming, setConfirming] = useState(false);
  const dirty = draft.userId !== (original?.userId ?? "") || draft.name !== (original?.name ?? "") || draft.department !== (original?.department ?? "");
  const save = useMutation({
    mutationFn: (remove: boolean) => api.saveDingtalkBinding(accountId, remove ? null : draft, original?.revision ?? null),
    onSuccess: async (_, removed) => { await client.invalidateQueries({ queryKey: ["dingtalk-bindings"] }); onSaved(removed); },
  });
  const change = (field: keyof DingTalkBindingInput, value: string) => { setDraft({ ...draft, [field]: value }); save.reset(); };
  return <Modal title={confirming ? "确认解除绑定" : original ? "修改人员绑定" : "配置人员绑定"} subtitle={email} onClose={onClose} dirty={dirty} pending={save.isPending}>
    {confirming ? <div className="dialog-form">
      <p className="confirmation-message">确认解除此账号与钉钉用户 {original?.userId} 的绑定？解除后，该人员将无法收到后续条目通知。</p>
      {save.isError && <p role="alert">{failure(save.error)}</p>}
      <div className="form-footer"><button type="button" className="secondary-button" onClick={() => { save.reset(); setConfirming(false); }}>返回修改</button><button type="button" className="danger-button" disabled={save.isPending} onClick={() => save.mutate(true)}>确认解除绑定</button></div>
    </div> : <form className="dialog-form" onSubmit={event => { event.preventDefault(); if (!save.isPending) save.mutate(false); }}>
      <label>钉钉企业用户 ID（userId）<input required maxLength={100} value={draft.userId} onChange={event => change("userId", event.target.value)} /></label>
      <label>钉钉姓名（选填）<input maxLength={100} value={draft.name} onChange={event => change("name", event.target.value)} /></label>
      <label>部门（选填）<input maxLength={200} value={draft.department} onChange={event => change("department", event.target.value)} /></label>
      <p className="account-note">需填写企业内 userId。邮箱、手机号和客户端展示的钉钉号不能替代它。手动填写的姓名与部门仅供核对。</p>
      {save.isError && <p role="alert">{failure(save.error)}</p>}
      <div className="form-footer">
        {original && <button type="button" className="danger-button" onClick={() => { save.reset(); setConfirming(true); }}>解除绑定</button>}
        <CancelDialogButton /><button className="primary-button" disabled={!dirty || save.isPending}>{save.isPending ? "正在保存…" : "保存人员绑定"}</button>
      </div>
    </form>}
  </Modal>;
}

function BindingTestDialog({ accountId, email, binding, test, disabled, onClose }: { accountId: string; email: string; binding: DingTalkBinding | undefined; test: DingTalkNotification | undefined; disabled: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["dingtalk-settings"], queryFn: api.dingtalkSettings });
  const [, tick] = useState(0);
  useEffect(() => {
    if (!test) return;
    const remaining = Date.parse(test.createdAt) + 30_000 - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => tick(value => value + 1), remaining + 1);
    return () => clearTimeout(timer);
  }, [test?.createdAt]);
  const send = useMutation({
    mutationFn: () => api.testDingtalkBinding(accountId),
    onSuccess: async notice => {
      client.setQueryData<Awaited<ReturnType<typeof api.dingtalkBindings>>>(["dingtalk-bindings"], previous => previous && ({ ...previous, tests: { ...previous.tests, [accountId]: notice } }));
      await client.invalidateQueries({ queryKey: ["dingtalk-bindings"] });
    },
  });
  const limited = Boolean(test && Date.now() - Date.parse(test.createdAt) < 30_000);
  return <Modal title="发送测试通知" subtitle={email} onClose={onClose} pending={send.isPending}>
    <div className="dialog-form">
      <dl className="dingtalk-info-grid">
        <div><dt>通知方式</dt><dd>{settings.data ? deliveryLabel(settings.data.deliveryMode) : "正在加载…"}</dd></div>
        <div><dt>接收人</dt><dd>{binding?.name || email}</dd></div>
        <div><dt>钉钉企业用户 ID（userId）</dt><dd>{binding?.userId || "未绑定"}</dd></div>
        {settings.data?.deliveryMode === "robot" && <div><dt>机器人编码（robotCode）</dt><dd>{settings.data.robotCode}</dd></div>}
      </dl>
      <p className="account-note">向以上人员发送一条账号绑定测试通知，收到后无需回复。测试不依赖项目通知开关。</p>
      {settings.data?.deliveryMode === "robot" && <p className="account-note">请到钉钉的机器人单聊会话查看通知。首次触达是否需要打开会话，以这次测试为准。</p>}
      {settings.isError && <p role="alert">{failure(settings.error)}</p>}
      {(!binding || disabled) && <p role="alert">{disabled ? "账号已停用，无法发送测试通知。" : "人员绑定已解除，请先重新绑定。"}</p>}
      {send.isError && <p role="alert">{failure(send.error)}</p>}
      {test && <div role="status"><NotificationState notice={test} /><p className="account-note">测试时间：{new Date(test.createdAt).toLocaleString()}</p></div>}
      {(limited || inProgress(test)) && <p className="account-note">请等待上次测试完成，至少间隔 30 秒后再发送。</p>}
      <div className="form-footer"><CancelDialogButton label="关闭" /><button type="button" className="primary-button" disabled={!binding || disabled || !settings.data?.configured || settings.isError || send.isPending || inProgress(test) || limited} onClick={() => send.mutate()}>{send.isPending ? "正在提交…" : "发送测试通知"}</button></div>
    </div>
  </Modal>;
}

function DingTalkBindingRow({ accountId, email, nickname, binding, test, disabled }: { accountId: string; email: string; nickname: string | null; binding: DingTalkBinding | undefined; test: DingTalkNotification | undefined; disabled: boolean }) {
  const [dialog, setDialog] = useState<"edit" | "test" | null>(null);
  const [saved, setSaved] = useState("");
  const name = binding?.name || nickname || email;
  return <article className="dingtalk-binding" aria-label={email}>
    <div className="dingtalk-binding-heading"><div className="dingtalk-binding-identity"><strong>{name}</strong>{name !== email && <span>{email}</span>}<small>{binding ? "已绑定" : "未绑定"}{disabled ? " · 账号已停用" : ""}</small></div>
      <div className="dingtalk-actions">
        <button type="button" className="secondary-button" onClick={() => { setSaved(""); setDialog("edit"); }}>{binding ? "修改绑定" : "配置绑定"}</button>
        <button type="button" className="secondary-button" disabled={!binding || disabled} onClick={() => setDialog("test")}>测试通知</button>
      </div>
    </div>
    {binding && <dl className="dingtalk-binding-info"><div><dt>钉钉 userId</dt><dd>{binding.userId}</dd></div><div><dt>部门</dt><dd>{binding.department || "未填写"}</dd></div></dl>}
    {test && <small className="dingtalk-last-test">最近测试：{statusLabels[test.status]} · {new Date(test.createdAt).toLocaleString()}</small>}
    {saved && <p role="status">{saved}</p>}
    {dialog === "edit" && <BindingEditorDialog accountId={accountId} email={email} binding={binding} onClose={() => setDialog(null)} onSaved={removed => { setSaved(removed ? "人员绑定已解除。" : "人员绑定已保存。"); setDialog(null); }} />}
    {dialog === "test" && <BindingTestDialog accountId={accountId} email={email} binding={binding} test={test} disabled={disabled} onClose={() => setDialog(null)} />}
  </article>;
}

function BindingImportDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const client = useQueryClient();
  const [csv, setCsv] = useState("");
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const currentSource = useRef(csv); currentSource.current = csv;
  const [preview, setPreview] = useState<{ data: DingTalkImportPreview; rows: DingTalkImportRow[] } | null>(null);
  const check = useMutation({
    mutationFn: async () => { const source = csv, rows = parseDingTalkCsv(source); return { source, rows, data: await api.previewDingtalkBindings(rows) }; },
    onSuccess: result => { if (result.source === currentSource.current) setPreview(result); },
  });
  const commit = useMutation({
    mutationFn: () => api.importDingtalkBindings(preview!.rows, preview!.data.fingerprint),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["dingtalk-bindings"] }); onSaved(); },
  });
  const setSource = (value: string) => { setCsv(value); setPreview(null); setError(""); check.reset(); commit.reset(); };
  return <Modal title="批量导入人员绑定" subtitle="按邮箱匹配已有账号" onClose={onClose} dirty={Boolean(csv)} pending={reading || check.isPending || commit.isPending} wide scrolls>
    <div className="dialog-form">
      <p className="account-note">最多 500 行，先预览再确认；已有账号的绑定会被所确认的内容替换。有问题的行须全部修正后再导入。</p>
      <label>选择 CSV 文件<input type="file" accept=".csv,text/csv" onChange={async event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        if (file.size > 256_000) { setError("文件超过 256 KB，请分批导入。"); return; }
        setReading(true);
        try { setSource(await file.text()); } catch { setError("文件读取失败。"); } finally { setReading(false); }
      }} /></label>
      <label>CSV 内容<textarea aria-label="CSV 内容" rows={5} maxLength={256000} value={csv} placeholder={"邮箱,钉钉用户 ID,姓名,部门\nperson@example.test,employee-id,姓名,部门"} onChange={event => setSource(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}{check.isError && <p role="alert">{failure(check.error)}</p>}{commit.isError && <p role="alert">{failure(commit.error)}</p>}
      {preview && <ol className="dingtalk-import-preview">{preview.data.rows.map((row, index) => <li key={index}><strong>{row.email}</strong><span>{row.userId} · {row.name} · {row.department}</span><small>{row.issue ?? "匹配成功，将保存此绑定"}</small></li>)}</ol>}
      <div className="form-footer"><CancelDialogButton />{preview
        ? <button type="button" className="primary-button" disabled={preview.data.rows.some(row => row.issue) || commit.isPending} onClick={() => commit.mutate()}>确认导入 {preview.data.rows.length} 条绑定</button>
        : <button type="button" className="primary-button" disabled={!csv.trim() || check.isPending || reading} onClick={() => check.mutate()}>预览匹配结果</button>}
      </div>
    </div>
  </Modal>;
}

export function DingTalkSettingsPage() {
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const bindings = useQuery({ queryKey: ["dingtalk-bindings"], queryFn: api.dingtalkBindings, refetchInterval: 5000 });
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const visibleAccounts = accounts.data?.accounts.filter(account => {
    const binding = bindings.data?.bindings.find(value => value.accountId === account.id);
    return [account.email, account.nickname, binding?.name, binding?.department].some(value => value?.toLowerCase().includes(search.toLowerCase()));
  });
  return <div className="dingtalk-settings"><IntegrationSummary /><section className="dingtalk-section">
    <div className="dingtalk-section-heading"><h2>人员绑定</h2><button type="button" className="secondary-button" onClick={() => { setImported(false); setImporting(true); }}>批量导入</button></div>
    <p className="account-note">管理员统一维护账号与钉钉人员的对应关系。</p>
    <label>搜索人员<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="邮箱、姓名或部门" /></label>
    {imported && <p role="status">人员绑定已导入。</p>}
    {accounts.isPending || bindings.isPending ? <p role="status">正在加载人员…</p> : accounts.isError || bindings.isError ? <p role="alert">{failure(accounts.error ?? bindings.error)}</p> :
      <div className="dingtalk-binding-list">{visibleAccounts?.length ? visibleAccounts.map(account => <DingTalkBindingRow key={account.id} accountId={account.id} email={account.email} nickname={account.nickname ?? null} disabled={Boolean(account.disabledAt)} binding={bindings.data.bindings.find(value => value.accountId === account.id)} test={bindings.data.tests[account.id]} />) : <p className="account-note">没有匹配的人员。</p>}</div>}
  </section>{importing && <BindingImportDialog onClose={() => setImporting(false)} onSaved={() => { setImported(true); setImporting(false); }} />}</div>;
}
export function DingTalkProjectSettings({productId}:{productId:string}) {
  const client=useQueryClient();const query=useQuery({queryKey:["dingtalk-project",productId],queryFn:()=>api.dingtalkProject(productId)});
  const [enabled,setEnabled]=useState(false);useEffect(()=>{if(query.data)setEnabled(query.data.enabled);},[query.data?.enabled]);
  const save=useMutation({mutationFn:()=>api.saveDingtalkProject(productId,enabled,query.data!.enabled),onSuccess:data=>client.setQueryData(["dingtalk-project",productId],data)});
  useSettingsDraft(Boolean(query.data && enabled!==query.data.enabled),save.isPending);
  if(query.isPending)return <p role="status">正在加载通知配置…</p>;
  if(query.isError)return <p role="alert">{failure(query.error)}</p>;
  return <section className="dingtalk-section"><h2>待验证通知</h2><p className="account-note">进入待验证时，通过管理员配置的钉钉通知方式提醒提需者；开启后不补发历史条目。</p>
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
  return <details className="dingtalk-item-notices"><summary>钉钉通知 · {statusLabels[query.data.notifications[0]!.status]}</summary><ol className="dingtalk-import-preview">{query.data.notifications.map((notice)=><li key={notice.id}>
    <NotificationState notice={notice} /><small>{notice.kind==="comment" ? "评论提醒" : "待验证提醒"}{notice.accountName ? ` · ${notice.accountName}` : ""}</small><small>{new Date(notice.createdAt).toLocaleString()} · 已尝试 {notice.attempts} 次</small>
    {(notice.canRetry ?? (notice.kind!=="comment" && pending)) && query.data.canRetry && ["failed","skipped","uncertain"].includes(notice.status) && <button type="button" className="secondary-button" disabled={retry.isPending} onClick={()=>notice.status==="uncertain"?setConfirm(notice.id):retry.mutate(notice.id)}>补发通知</button>}
  </li>)}</ol>{retry.isError && <p role="alert">{failure(retry.error)}</p>}
    {confirm && <Modal title="确认补发通知" subtitle="此前发送结果不明" onClose={()=>setConfirm(null)} pending={retry.isPending}><p>此前消息可能已送达。请先核实接收情况，补发可能产生重复通知。</p><div className="form-footer"><button type="button" className="secondary-button" onClick={()=>setConfirm(null)} disabled={retry.isPending}>取消</button><button type="button" className="primary-button" onClick={()=>retry.mutate(confirm)} disabled={retry.isPending}>已核实，补发通知</button></div></Modal>}
  </details>;
}
