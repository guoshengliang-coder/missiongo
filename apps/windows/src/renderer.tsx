import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { Modal } from "../../web/src/modal";
import { Select } from "../../web/src/select";
import { I18nProvider } from "../../web/src/i18n";
import { useBeforeUnloadGuard } from "../../web/src/unsaved-changes";
import type { DesktopBridge, DesktopPreferences, DesktopRequest, DesktopSnapshot } from "./contracts.js";
import type { AgentConfig, Kind } from "../../node/src/types.js";
import "./styles.css";

declare const PRODUCT_NAME: string;
declare global { interface Window { desktop: DesktopBridge } }
const agents: [Kind, string][] = [["codex", "Codex"], ["claude_code", "Claude Code"], ["opencode", "OpenCode"]];
const connectionLabel = (state?: string) => ({ online: "已连接", stopped: "已停止", degraded: "连接异常", credential_revoked: "凭据已撤销" }[state ?? ""] ?? (state && /[\u4e00-\u9fff]/.test(state) ? state : "等待心跳"));
type Editor = { kind: "agent"; agent: Kind } | { kind: "repository"; productId: string } | { kind: "preferences" | "rename" | "logout" | "managed" };

function Desktop() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>();
  const [error, setError] = useState(""); const [status, setStatus] = useState("");
  const [editor, setEditor] = useState<Editor>(); const [busy, setBusy] = useState(false);
  const [server, setServer] = useState(""); const [name, setName] = useState("");
  const [authorization, setAuthorization] = useState<{ code: string; url: string }>();
  useBeforeUnloadGuard(busy || (!snapshot?.registered && Boolean(server || name)));
  const refresh = async () => { const value = await window.desktop.request<DesktopSnapshot>({ method: "snapshot" }); setSnapshot(value); };
  const invoke = async (request: DesktopRequest) => {
    setError(""); setBusy(true);
    try { const result = await window.desktop.request(request); await refresh(); return result; }
    catch (error) { setError(error instanceof Error ? error.message : "操作失败，请重试"); throw error; }
    finally { setBusy(false); }
  };
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await window.desktop.request<DesktopSnapshot>({ method: "snapshot" }); if (active) setSnapshot(value); }
      catch (error) { if (active) setError(error instanceof Error ? error.message : "无法读取本机状态"); }
      finally { if (active) timer = setTimeout(() => void poll(), 3000); }
    };
    void poll();
    const unsubscribe = window.desktop.subscribe((event) => {
      if (event.type === "authorization") setAuthorization(event);
      else if (event.type === "status" && event.text !== "theme") setStatus(event.text);
    });
    const theme = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { document.documentElement.dataset.appearance = theme.matches ? "dark" : "light"; };
    apply(); theme.addEventListener("change", apply);
    return () => { active = false; clearTimeout(timer); unsubscribe(); theme.removeEventListener("change", apply); };
  }, []);
  const login = (event: FormEvent) => { event.preventDefault(); void invoke({ method: "login", server, name }).catch(() => {}).finally(() => setAuthorization(undefined)); };
  return <main className="desktop-shell">
    <header className="desktop-toolbar">
      <div className="desktop-brand"><img src="./icon.svg" alt="" /><div><h1>{PRODUCT_NAME}</h1><p>Windows 客户端 · {snapshot?.version ?? "正在加载"}</p></div></div>
      <button className="secondary-button" disabled={!snapshot || busy} onClick={() => setEditor({ kind: "preferences" })}>本机设置</button>
    </header>
    {error && <div className="desktop-error" role="alert">{error}<button className="secondary-button" onClick={() => { setError(""); void refresh().catch(() => setError("刷新失败，请检查执行环境")); }}>重试</button></div>}
    {status && <p className="account-note" role="status">{status}</p>}
    {!snapshot ? <p role="status">正在读取本机状态…</p> : <>
      <section className="desktop-card"><h2>执行环境</h2><p>{snapshot.preferences.runtime === "native" ? "Windows 原生" : `WSL · ${snapshot.preferences.distribution}`}</p>
        {snapshot.runtimeError && <p className="desktop-error" role="alert">{snapshot.runtimeError}。请在本机设置中检查并重新保存执行环境。</p>}
        <p className="account-note">原生和各 WSL 发行版分别保存登录、仓库与 Agent 配置。切换环境会暂停原环境接单，已有会话保留。</p></section>
      {!snapshot.registered ? <section className="desktop-card"><h2>连接服务器</h2>
        <form onSubmit={login} className="desktop-form">
          <label>服务器地址<input required type="url" value={server} placeholder="https://missiongo.example.com" disabled={busy} onChange={(e) => setServer(e.target.value)} /></label>
          <label>设备名称<input value={name} disabled={busy} placeholder="为此执行环境命名" onChange={(e) => setName(e.target.value)} /></label>
          <p className="account-note">登录将在浏览器完成。模型账号、API Key 和网关继续使用各 Agent 的已有配置。</p>
          {authorization && <div role="status"><p>请在打开的浏览器中完成授权，设备码：<strong>{authorization.code}</strong></p><p className="desktop-path">{authorization.url}</p></div>}
          <div className="desktop-actions"><button className="primary-button" disabled={busy || !!snapshot.runtimeError}>{busy ? "等待授权…" : "登录并连接"}</button>
            {(busy || snapshot.loginPending) && <button type="button" className="secondary-button" onClick={() => void window.desktop.request({ method: "cancelLogin" }).catch(() => {})}>取消登录</button>}</div>
        </form></section> : <>
        <section className="desktop-card"><div className="desktop-row"><div><h2>{snapshot.name || "本机节点"}</h2><p className="desktop-path">{snapshot.server}</p><p role="status">{snapshot.running ? "接单连接已启动" : "已暂停接单"} · {connectionLabel(snapshot.health?.state)}</p></div>
          <button className="primary-button" disabled={busy} onClick={() => void invoke({ method: "run", enabled: !snapshot.running }).catch(() => {})}>{snapshot.running ? "暂停接单" : "开始接单"}</button></div>
          <div className="desktop-actions"><button className="secondary-button" disabled={busy} onClick={() => void invoke({ method: "openConsole" }).catch(() => {})}>打开控制台</button><button className="secondary-button" onClick={() => setEditor({ kind: "rename" })}>修改设备名称</button></div>
        </section>
        <section className="desktop-card"><h2>Agent 集成</h2><p className="account-note">只检查你明确启用的客户端。支持安装包、npm、PATH、自定义启动器和环境脚本；检查配置不代表模型请求已成功。</p>
          {agents.map(([kind, label]) => { const health = snapshot.health?.agents?.find((a) => a.kind === kind); return <div className="desktop-row" key={kind}><div><h3>{label}</h3><p>{!snapshot.agents[kind] ? "未启用" : health?.ready ? `可用 · ${health.version ?? "已连接"}` : health?.unavailableReason ?? "已启用，等待检查"}</p>{health?.modes && <details><summary>原生权限能力</summary>{health.modes.map((entry, index) => <p key={index}>{entry.model ? `${entry.model} · ` : ""}{entry.mode} · {{available:"可用",unavailable:"不可用",unknown:"未确认"}[entry.state] ?? "未确认"}</p>)}</details>}</div><div className="desktop-actions"><button className="secondary-button" onClick={() => setEditor({ kind: "agent", agent: kind })}>{snapshot.agents[kind] ? "配置" : "启用"}</button>{snapshot.agents[kind] && <button className="secondary-button" disabled={busy} onClick={() => void invoke({ method: "checkAgent", kind }).then(() => setStatus(`${label} 检查结束，连接状态将随心跳刷新`)).catch(() => {})}>重新检查</button>}</div></div>; })}
          <p className="account-note">终端会话可使用桥接入口：原生环境请在 PowerShell 中执行，按提示填写仓库路径；WSL 请在所选发行版中替换路径占位符。可将 claude_code 换为 codex 或 opencode。</p>
          <button className="secondary-button" disabled={busy} onClick={() => void invoke({ method: "copyBridgeCommand" }).then(() => setStatus("桥接命令已复制，请在所选执行环境的终端中使用")).catch(() => {})}>复制终端桥接命令</button>
        </section>
        <section className="desktop-card"><div className="desktop-row"><div><h2>受控执行</h2><p>{snapshot.managedEnabled ? "已允许此环境接收受控 Codex 任务" : "未启用"}</p></div><button className="secondary-button" disabled={busy || !snapshot.agents.codex} onClick={() => setEditor({ kind: "managed" })}>设置受控执行</button></div><p className="account-note">仅接收已批准的阶段和节点绑定；每次启动及首次执行前重新核对许可。关闭后停止已有受控任务的当前轮次。</p></section>
        <section className="desktop-card"><h2>项目仓库</h2>{snapshot.products.length === 0 && <p>暂无可访问项目，联网后将自动刷新。</p>}
          {snapshot.products.map((product) => <div className="desktop-row" key={product.id}><div><h3>{product.name}</h3><p className="desktop-path">{snapshot.repos.find((r) => r.productId === product.id)?.repoPath ?? "尚未关联仓库"}</p></div><button className="secondary-button" onClick={() => setEditor({ kind: "repository", productId: product.id })}>选择仓库</button></div>)}
        </section>
        <section className="desktop-card"><h2>客户端更新</h2><p role="status">{{ idle: "尚未检查", checking: "正在检查…", current: "已是最新版本", available: "有可用更新", downloading: "正在下载并核对…", ready: "更新已通过校验，可安装并重启", cancelling: "正在取消下载…", cancelled: "下载已取消，可重新下载", verifying: "正在校验更新签名…", installing: "正在安装并重启…", failed: snapshot.update?.error ?? "检查失败" }[snapshot.update?.state ?? "idle"]} {snapshot.update?.version}</p>{snapshot.update?.state === "downloading" && <p role="status">下载进度 {Math.floor(snapshot.update.percent ?? 0)}%<progress aria-label="更新下载进度" max={100} value={snapshot.update.percent ?? 0} /></p>}
          {snapshot.update?.notes && <details><summary>更新内容</summary><p className="desktop-path">{snapshot.update.notes}</p></details>}
          <div className="desktop-actions"><button className="secondary-button" disabled={busy || ["downloading", "cancelling", "verifying", "installing", "checking"].includes(snapshot.update?.state ?? "")} onClick={() => void invoke({ method: "checkUpdates" }).catch(() => {})}>检查更新</button>{Boolean(snapshot.update?.version) && ["available", "ready", "cancelled", "failed"].includes(snapshot.update?.state ?? "") && <button className="secondary-button" disabled={busy} onClick={() => void invoke({ method: "installUpdate" }).catch(() => {})}>{snapshot.update?.state === "ready" ? "安装并重启" : "下载更新"}</button>}{snapshot.update?.state === "downloading" && <button className="secondary-button" disabled={busy} onClick={() => void invoke({method:"cancelUpdate"}).catch(() => {})}>取消下载</button>}</div></section>
        <section className="desktop-card"><button className="secondary-button" disabled={busy} onClick={() => setEditor({ kind: "logout" })}>退出此环境的登录</button></section>
      </>}
      {editor && <EditorForm key={JSON.stringify(editor)} editor={editor} snapshot={snapshot} close={() => setEditor(undefined)} invoke={invoke} />}
    </>}
  </main>;
}

function EditorForm({ editor, snapshot, close, invoke }: { editor: Editor; snapshot: DesktopSnapshot; close: () => void; invoke: (value: DesktopRequest) => Promise<unknown> }) {
  const original: AgentConfig = editor.kind === "agent" ? snapshot.agents[editor.agent] ?? {} : {};
  const [settings, setSettings] = useState<AgentConfig>(() => Object.fromEntries(Object.entries(original).filter(([key]) => key !== "checkRevision")));
  const [path, setPath] = useState(editor.kind === "repository" ? snapshot.repos.find((r) => r.productId === editor.productId)?.repoPath ?? "" : snapshot.name ?? "");
  const [preferences, setPreferences] = useState<DesktopPreferences>(snapshot.preferences);
  const [managed, setManaged] = useState(snapshot.managedEnabled);
  const [distributions, setDistributions] = useState(snapshot.distributions);
  const [pending, setPending] = useState(false); const [error, setError] = useState("");
  const dirty = editor.kind === "agent" ? JSON.stringify(settings) !== JSON.stringify(Object.fromEntries(Object.entries(original).filter(([key]) => key !== "checkRevision")))
    : editor.kind === "preferences" ? JSON.stringify(preferences) !== JSON.stringify(snapshot.preferences)
      : editor.kind === "managed" ? managed !== snapshot.managedEnabled : editor.kind === "repository" ? path !== (snapshot.repos.find((r) => r.productId === editor.productId)?.repoPath ?? "") : editor.kind === "rename" && path !== snapshot.name;
  const save = async (remove = false) => {
    setError(""); setPending(true);
    try {
      if (editor.kind === "agent") await invoke({ method: "agent", kind: editor.agent, enabled: !remove, settings });
      else if (editor.kind === "repository") await invoke({ method: "repository", productId: editor.productId, ...(remove ? {} : { path }) });
      else if (editor.kind === "preferences") await invoke({ method: "preferences", value: preferences });
      else if (editor.kind === "rename") await invoke({ method: "rename", name: path });
      else if (editor.kind === "managed") await invoke({ method: "managed", enabled: managed });
      else await invoke({ method: "logout" });
      close();
    } catch (error) { setError(error instanceof Error ? error.message : "保存失败，输入已保留"); } finally { setPending(false); }
  };
  const choose = async (method: "chooseFile" | "chooseDirectory", apply: (path: string) => void) => {
    try { const value = await window.desktop.request<string | undefined>({ method }); if (value) apply(value); }
    catch (error) { setError(error instanceof Error ? error.message : "选择失败"); }
  };
  return <Modal title={{ agent: "Agent 配置", repository: "关联项目仓库", preferences: "本机设置", rename: "设备名称", logout: "退出登录", managed: "受控执行设置" }[editor.kind]} subtitle={PRODUCT_NAME} onClose={close} dirty={dirty} pending={pending} scrolls>
    <form className="desktop-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {error && <p role="alert" className="desktop-error">{error}</p>}
      {editor.kind === "agent" && <><p>保存将明确启用 {agents.find(([kind]) => kind === editor.agent)?.[1]}，允许检查本机配置及同步 MissionGo Skill。认证和模型配置保留在本机。</p>
        {(["executable", "environmentScript", "shellExecutable", ...(editor.agent === "opencode" ? ["serviceRegistration"] : [])] as (keyof AgentConfig)[]).map((key) => <label key={key}>{{ executable: "自定义启动器（留空使用 PATH 和常见安装目录）", environmentScript: "环境脚本（Windows 使用 .ps1，或显式指定 Bash）", shellExecutable: "脚本解释器（可选绝对路径）", serviceRegistration: "OpenCode 共享服务登记文件（可选）", checkRevision: "" }[key]}<div className="desktop-input-row"><input value={settings[key] ?? ""} onChange={(e) => setSettings((previous) => { const next = { ...previous }; if (e.target.value) next[key] = e.target.value; else delete next[key]; return next; })} />{snapshot.preferences.runtime === "native" && <button type="button" className="secondary-button" onClick={() => void choose("chooseFile", (value) => setSettings((old) => ({ ...old, [key]: value })))}>浏览</button>}</div></label>)}
        <p className="account-note">不会自动执行终端 profile 或解析 alias。请将所需设置放入明确选择的脚本；检查和会话将使用同一启动器与环境。</p></>}
      {(editor.kind === "repository" || editor.kind === "rename") && <label>{editor.kind === "repository" ? "当前执行环境中的 Git 仓库根目录" : "设备名称"}<div className="desktop-input-row"><input required value={path} onChange={(e) => setPath(e.target.value)} />{editor.kind === "repository" && snapshot.preferences.runtime === "native" && <button type="button" className="secondary-button" onClick={() => void choose("chooseDirectory", setPath)}>浏览</button>}</div></label>}
      {editor.kind === "preferences" && <>
        <label>执行环境<Select value={preferences.runtime} onChange={(e) => setPreferences((old) => ({ ...old, runtime: e.target.value as "native" | "wsl" }))}><option value="native">Windows 原生</option><option value="wsl">WSL</option></Select></label>
        {preferences.runtime === "wsl" && <><label>WSL 发行版<input required value={preferences.distribution} list="wsl-distributions" onChange={(e) => setPreferences((old) => ({ ...old, distribution: e.target.value }))} /><datalist id="wsl-distributions">{distributions.map((name) => <option key={name} value={name} />)}</datalist></label><button type="button" className="secondary-button" onClick={() => void window.desktop.request<string[]>({ method: "listDistributions" }).then(setDistributions).catch(() => setError("无法读取 WSL，请检查其安装状态"))}>读取已安装的发行版</button><label>WSL Node.js 绝对路径<input required value={preferences.wslNodeExecutable ?? "/usr/bin/node"} onChange={(e) => setPreferences((old) => ({ ...old, wslNodeExecutable: e.target.value }))} /></label><p className="account-note">可填写 nvm 安装的 Node.js 完整路径；不会加载终端 profile。该发行版需已有 Node.js 22.13+、Git、flock 和所需 Agent。切换不会复制 Windows 的认证材料。</p></>}
        {(["launchAtLogin", "startHidden", "notifications"] as const).map((key) => <label className="desktop-check" key={key}><input type="checkbox" checked={preferences[key]} onChange={(e) => setPreferences((old) => ({ ...old, [key]: e.target.checked }))} />{{ launchAtLogin: "登录 Windows 后启动客户端", startHidden: "启动时收起到托盘", notifications: "显示会话待处理通知" }[key]}</label>)}
      </>}
      {editor.kind === "logout" && <p>将暂停此环境接单并删除本地节点凭据。已有 Agent 会话继续存在；若要使其他运行副本失效，请在控制台撤销设备。</p>}
      {editor.kind === "managed" && <><p>允许此环境为已批准的受控阶段创建独立 worktree 和 Codex 会话。执行器可写入任务仓库，审查器只读；不自动恢复身份或启动结果不明的任务。</p><p className="account-note">需要与服务端协议匹配的 Codex 版本；自定义配置不会绕过模型、目录和 MCP 隔离校验。</p><label className="desktop-check"><input type="checkbox" checked={managed} onChange={(e) => setManaged(e.target.checked)} />允许此环境接收受控执行</label></>}
      <div className="form-footer"><button type="button" className="secondary-button" disabled={pending} onClick={close}>取消</button>{(editor.kind === "repository" || editor.kind === "agent") && <button type="button" className="secondary-button" disabled={pending} onClick={() => void save(true)}>{editor.kind === "agent" ? "停用" : "移除关联"}</button>}<button className="primary-button" disabled={pending}>{pending ? "正在保存…" : editor.kind === "logout" ? "退出登录" : "保存"}</button></div>
    </form>
  </Modal>;
}

createRoot(document.getElementById("root")!).render(<I18nProvider><Desktop /></I18nProvider>);
