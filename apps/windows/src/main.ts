import { app, BrowserWindow, Menu, Tray, ipcMain, dialog, shell, clipboard, nativeTheme, Notification, powerMonitor } from "electron";
import { CancellationToken } from "builder-util-runtime";
import { DesktopUpdates } from "./updates.js";
import { autoUpdater } from "electron-updater";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { DesktopBackend, windowsCommand, listWslDistributions } from "./backend.js";
import { replaceBackend, wslLaunch, type BackendSelection } from "./selection.js";
import { prepareRuntime } from "./runtime.js";
import { initializeNativeSecurity } from "./security.js";
import { privateDir, readPrivate, savePrivate, safeError } from "../../node/src/storage.js";
import { serverOrigin } from "../../node/src/api.js";
import type { DesktopRequest, DesktopSnapshot, DesktopPreferences, DesktopEvent } from "./contracts.js";
import { windowsSystemExecutable } from "../../node/src/launch.js";

declare const PRODUCT_NAME: string;
declare const WINDOWS_APP_ID: string;
declare const WINDOWS_PUBLISHER: string;
declare const NODE_VERSION: string;

app.setName(PRODUCT_NAME);
app.setAppUserModelId(WINDOWS_APP_ID);
if (!app.requestSingleInstanceLock()) app.quit();
else void app.whenReady().then(async () => {
  if (!app.isPackaged && process.env.MISSIONGO_DESKTOP_TEST_HOME) app.setPath("userData", process.env.MISSIONGO_DESKTOP_TEST_HOME);
  initializeNativeSecurity();
  const state = join(app.getPath("userData"), "local"); privateDir(state);
  const preferencePath = join(state, "preferences.json");
  let preferences: DesktopPreferences = readPrivate<DesktopPreferences>(preferencePath) ?? {
    runtime: "native", distribution: "", wslNodeExecutable: "/usr/bin/node", launchAtLogin: false, startHidden: false, notifications: true,
  };
  const runtime = prepareRuntime(app.isPackaged ? join(process.resourcesPath, "runtime") : join(__dirname, "../runtime"), state);
  const html = join(__dirname, "index.html"); const trustedURL = pathToFileURL(html).href;
  let window: BrowserWindow | undefined;
  let quitting = false; let authorizationOrigin: string | undefined;
  let backend: Pick<DesktopBackend, "request" | "close">;
  let backendFailed = false; let bridgeCommand = "";
  const unavailable = (message: string): Pick<DesktopBackend, "request" | "close"> => {
    backendFailed = true;
    return { request: async (request) => {
      if (request.method !== "snapshot") throw new Error(message);
      return { version: NODE_VERSION, registered: false, running: false, loginPending: false, managedEnabled: false,
        agents: {}, products: [], repos: [], runtimeError: message };
    }, close: async () => {} };
  };
  const updates = new DesktopUpdates();
  const emit = (event: DesktopEvent) => window?.webContents.send("desktop:event", event);
  const show = () => { if (!window) createWindow(); window!.show(); window!.focus(); };
  const onEvent = (event: DesktopEvent) => {
    if (event.type === "authorization") {
      try {
        const url = new URL(event.url);
        if (url.origin !== authorizationOrigin || url.username || url.password) return;
        void shell.openExternal(url.href);
      } catch { return; }
    }
    if (event.type === "attention" && preferences.notifications && Notification.isSupported()) {
      const notification = new Notification({ title: PRODUCT_NAME, body: "会话有新消息或需要你处理，请打开控制台查看。" });
      notification.on("click", show); notification.show();
    }
    emit(event);
  };
  async function createBackend(value: DesktopPreferences): Promise<BackendSelection<DesktopBackend>> {
    if (value.runtime === "native") {
      const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
      // Paste into PowerShell: avoid ANSI .cmd files in non-ASCII user paths,
      // avoid changing execution policy, and restore the terminal environment.
      const bridgeCommand = `& { $previous = $env:MISSIONGO_NODE_HOME; try { $env:MISSIONGO_NODE_HOME = ${quote(join(state, "native"))}; & ${quote(runtime.node)} ${quote(runtime.worker)} _bridge --agent claude_code --cwd (Read-Host '仓库绝对路径') } finally { $env:MISSIONGO_NODE_HOME = $previous } }`;
      return { bridgeCommand, backend: new DesktopBackend(runtime.node, [runtime.worker, "--worker"], { ...process.env, MISSIONGO_NODE_HOME: join(state, "native") }, onEvent) };
    }
    const names = await listWslDistributions();
    if (!names.includes(value.distribution)) throw new Error("请选择已安装的 WSL 发行版");
    const entry = await windowsCommand("wsl.exe", ["--distribution", value.distribution, "--exec", "wslpath", "-a", "-u", runtime.worker]);
    const launch = wslLaunch(value.distribution, value.wslNodeExecutable ?? "/usr/bin/node", entry);
    return { bridgeCommand: launch.bridgeCommand, backend: new DesktopBackend("wsl.exe", launch.args, process.env, onEvent) };
  }
  function createWindow() {
    window = new BrowserWindow({ width: 1000, height: 780, minWidth: 560, minHeight: 500, title: PRODUCT_NAME,
      icon: join(__dirname, "icon.png"), show: false, autoHideMenuBar: true,
      webPreferences: { preload: join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, partition: "persist:local-settings" },
    });
    window.webContents.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => { if (url !== trustedURL) event.preventDefault(); });
    window.webContents.on("will-prevent-unload", (event) => {
      const choice = dialog.showMessageBoxSync(window!, { type: "question", message: "有未保存的输入或正在进行的操作", detail: "退出会放弃界面草稿。已有 Agent 会话仍保留。", buttons: ["继续编辑", "放弃并退出"], defaultId: 0, cancelId: 0 });
      if (choice === 1) event.preventDefault();
      else { quitting = false; updates.deferInstall(); }
    });
    window.on("close", (event) => { if (!quitting) { event.preventDefault(); window!.hide(); } });
    window.on("closed", () => { window = undefined; if (quitting) finishQuit(); });
    window.once("ready-to-show", () => { if (!preferences.startHidden) window?.show(); });
    void window.loadFile(html);
  }
  try { ({ backend, bridgeCommand } = await replaceBackend(undefined, await createBackend(preferences))); } catch (error) { backend = unavailable(safeError(error)); }
  createWindow();
  const tray = new Tray(join(__dirname, "icon.png"));
  tray.setToolTip(PRODUCT_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开客户端", click: show }, { label: "收起到托盘", click: () => window?.hide() }, { type: "separator" },
    { label: "退出客户端", click: () => app.quit() },
  ]));
  tray.on("click", show); app.on("second-instance", show); app.on("activate", show);
  nativeTheme.on("updated", () => emit({ type: "status", text: "theme" }));
  autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = false; autoUpdater.allowDowngrade = false; autoUpdater.logger = null;
  autoUpdater.on("update-not-available", () => { updates.current(); });
  autoUpdater.on("update-available", (info) => { updates.available(info.version,info.releaseNotes); });
  autoUpdater.on("error", () => { updates.failed(); });
  autoUpdater.on("download-progress", (progress) => updates.progress(progress));
  autoUpdater.on("update-downloaded", (info) => {
    if (!updates.verifying()) return;
    // Unsigned developer builds cannot authorize an unattended installer.
    const program = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $r=[Console]::In.ReadLine() | ConvertFrom-Json; $s=Get-AuthenticodeSignature -LiteralPath $r.path; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.GetNameInfo('SimpleName',$false) -ne $r.publisher) { exit 1 }; exit 0";
    const checked = WINDOWS_PUBLISHER && spawnSync(windowsSystemExecutable("powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(program, "utf16le").toString("base64")], {
      input: JSON.stringify({ path: info.downloadedFile, publisher: WINDOWS_PUBLISHER }) + "\n", windowsHide: true, stdio: ["pipe", "ignore", "ignore"], timeout: 20_000,
    });
    updates.verified(Boolean(checked && !checked.error && checked.status === 0));
  });
  ipcMain.handle("desktop:request", async (event, value: DesktopRequest): Promise<unknown> => {
    if (event.senderFrame?.url !== trustedURL || event.sender !== window?.webContents) throw new Error("本地界面来源无效");
    if (!value || typeof value !== "object" || JSON.stringify(value).length > 64_000) throw new Error("无效请求");
    switch (value.method) {
      case "snapshot": {
        const snapshot = await backend.request(value) as DesktopSnapshot;
        return { ...snapshot, preferences, update: updates.snapshot, distributions: preferences.runtime === "wsl" ? await listWslDistributions().catch(() => []) : [] };
      }
      case "chooseDirectory": case "chooseFile": {
        if (preferences.runtime !== "native") throw new Error("WSL 路径请在所选发行版中填写绝对路径");
        const result = await dialog.showOpenDialog(window!, { properties: [value.method === "chooseDirectory" ? "openDirectory" : "openFile"] });
        return result.canceled ? undefined : result.filePaths[0];
      }
      case "listDistributions": return listWslDistributions();
      case "copyBridgeCommand": clipboard.writeText(bridgeCommand); return {};
      case "preferences": {
        const next = value.value;
        if (next.wslNodeExecutable !== undefined && typeof next.wslNodeExecutable !== "string") throw new Error("无效的 WSL Node.js 路径");
        if (next.runtime === "wsl") wslLaunch(next.distribution, next.wslNodeExecutable ?? "/usr/bin/node", "");
        if (!["native", "wsl"].includes(next.runtime) || typeof next.distribution !== "string" || next.distribution.length > 100
          || /[\r\n\0]/.test(next.distribution) || [next.launchAtLogin, next.startHidden, next.notifications].some((v) => typeof v !== "boolean")) throw new Error("无效的本机设置");
        if (backendFailed || next.runtime !== preferences.runtime || next.distribution !== preferences.distribution || next.wslNodeExecutable !== preferences.wslNodeExecutable) {
          ({ backend, bridgeCommand } = await replaceBackend({ backend, bridgeCommand }, await createBackend(next)));
          backendFailed = false;
        }
        app.setLoginItemSettings({ openAtLogin: next.launchAtLogin, args: next.startHidden ? ["--hidden"] : [] });
        preferences = next; savePrivate(preferencePath, preferences); return {};
      }
      case "openConsole": {
        const current = await backend.request({ method: "snapshot" }) as DesktopSnapshot;
        if (current.server) await shell.openExternal(serverOrigin(current.server)); return {};
      }
      case "checkUpdates": {
        const current = await backend.request({ method: "snapshot" }) as DesktopSnapshot;
        if (!current.server) throw new Error("先登录服务器，再检查更新");
        if (!app.isPackaged) throw new Error("开发运行不安装更新，请使用已签名安装包验证");
        autoUpdater.setFeedURL({ provider: "generic", url: `${serverOrigin(current.server)}/downloads/windows/` });
        updates.checking(); await autoUpdater.checkForUpdates(); return updates.snapshot;
      }
      case "cancelUpdate": updates.cancel(); return updates.snapshot;
      case "installUpdate": {
        if (!WINDOWS_PUBLISHER) throw new Error("此开发构建未配置正式更新签名身份，请从下载页手动安装可信版本");
        if (updates.snapshot.state === "ready") { updates.installing(); autoUpdater.quitAndInstall(false, true); return {}; }
        const cancellation = new CancellationToken(); updates.begin(() => cancellation.cancel());
        void autoUpdater.downloadUpdate(cancellation).then(() => updates.settled(), () => updates.settled(true));
        return updates.snapshot;
      }
      case "login": {
        authorizationOrigin = serverOrigin(value.server);
        try { const result = await backend.request(value); await backend.request({ method: "run", enabled: true }); return result; }
        finally { authorizationOrigin = undefined; }
      }
      case "cancelLogin": case "logout": case "agent": case "checkAgent": case "repository": case "rename": case "run": case "managed": return backend.request(value);
      default: throw new Error("不支持的本地操作");
    }
  });
  powerMonitor.on("resume", () => emit({ type: "status", text: "设备已唤醒，节点将重新核对连接和原会话" }));
  let closing = false;
  function finishQuit() {
    if (closing) return;
    closing = true;
    void backend.close().finally(() => { tray.destroy(); app.quit(); });
  }
  app.on("before-quit", (event) => {
    if (closing) return;
    event.preventDefault(); quitting = true;
    if (window) window.close(); else finishQuit();
  });
  let initial: DesktopSnapshot;
  try { initial = await backend.request({ method: "snapshot" }) as DesktopSnapshot; }
  catch (error) { await backend.close(); backend = unavailable(safeError(error)); initial = await backend.request({ method: "snapshot" }) as DesktopSnapshot; }
  if (initial.registered) void backend.request({ method: "run", enabled: true }).catch((error) => emit({ type: "status", text: safeError(error) }));
  if (!preferences.startHidden || !initial.registered) show();
}).catch((error) => { dialog.showErrorBox(PRODUCT_NAME, safeError(error)); app.quit(); });
