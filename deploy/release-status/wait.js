// This host-served page works even while both application containers are down.
const title = document.getElementById("title");
const message = document.getElementById("message");
const retry = document.getElementById("retry");
const english = !navigator.language.startsWith("zh");
const words = (zh, en) => english ? en : zh;
let sawUpgrade = false;
let busy = false;
retry.textContent = words("重试", "Retry");
async function check() {
  if (busy) return;
  busy = true;
  let waiting = false;
  try {
    const response = await fetch("/release-status.json", { cache: "no-store", signal: AbortSignal.timeout(5000) });
    const state = response.ok ? await response.json() : null;
    const known = state?.version === 1 && Number.isSafeInteger(state.expiresAt);
    const active = known && state.phase === "upgrading" && state.expiresAt > Date.now() && state.expiresAt <= Date.now() + 900000;
    if (active) {
      sawUpgrade = true;
      waiting = true;
      title.textContent = words("正在发布新版本", "A new version is being deployed");
      message.textContent = words("正在升级更新，请稍等几分钟。页面会自动重新连接。", "Please wait a few minutes. The page will reconnect automatically.");
      retry.disabled = true;
      return;
    }
    if (sawUpgrade && known && state.phase === "idle") {
      const health = await fetch("/health", { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (health.ok && (await health.json()).status === "ok") { location.reload(); return; }
    }
    title.textContent = words("暂时无法连接", "Connection unavailable");
    message.textContent = words("尚未确认服务恢复。请稍后重试。", "Recovery has not been confirmed. Please retry later.");
  } catch {
    title.textContent = words("暂时无法连接", "Connection unavailable");
    message.textContent = words("请检查网络或稍后重试。", "Check your connection or retry later.");
  } finally { busy = false; retry.disabled = waiting; }
}
retry.addEventListener("click", () => location.reload());
void check();
setInterval(() => { if (document.visibilityState === "visible") void check(); }, 3000);
