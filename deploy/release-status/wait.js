// Host-served fallback: status is independent of application containers.
const title = document.getElementById("title");
const message = document.getElementById("message");
const retry = document.getElementById("retry");
const english = !navigator.language.startsWith("zh");
const words = (zh, en) => english ? en : zh;
const reasons = {
  restart_check_failed: ["服务重启检查未通过，具体原因未知。", "Service restart checks did not pass; the cause is unknown."],
  health_timeout: ["服务健康检查超时，暂时无法确认更新完成。", "The service health check timed out; completion is unconfirmed."],
  health_unavailable: ["暂时无法连接健康检查接口。", "The health endpoint could not be reached."],
  health_mismatch: ["运行版本与更新目标不一致。", "The running version does not match the update target."],
  health_invalid: ["健康检查结果无效。", "The health check result was invalid."],
};
let busy = false;
let sawUpgrade = false;
async function check(manual = false) {
  if (busy) return;
  busy = true;
  retry.disabled = true;
  retry.textContent = words("正在检查…", "Checking…");
  let waiting = false;
  try {
    const response = await fetch("/release-status.json", { cache: "no-store", signal: AbortSignal.timeout(5000) });
    const state = response.ok ? await response.json() : null;
    const known = state?.version === 1 && typeof state.release === "string" && Number.isSafeInteger(state.expiresAt)
      && ["idle", "upgrading", "failed"].includes(state.phase);
    if (!known) throw new Error("invalid");
    const bounded = state.expiresAt > Date.now() && state.expiresAt <= Date.now() + 900000;
    if (state.phase === "upgrading" && bounded) {
      waiting = true;
      sawUpgrade = true;
      title.textContent = words("正在发布新版本", "A new version is being deployed");
      message.textContent = words("正在升级更新，请稍等几分钟。恢复后会自动重新连接。", "Please wait a few minutes. The page will reconnect after recovery.");
      return;
    }
    if (state.phase === "idle" && (sawUpgrade || manual)) {
      const health = await fetch("/health", { cache: "no-store", signal: AbortSignal.timeout(5000) });
      const result = health.ok ? await health.json() : null;
      if (result?.status === "ok" && result.release === state.release) { location.reload(); return; }
      title.textContent = words("尚未确认服务恢复", "Service recovery is unconfirmed");
      message.textContent = words("服务健康或版本检查未通过，请稍后重新检查。", "Health or version checks have not passed. Check again later.");
      return;
    }
    const failed = state.phase === "failed" && bounded;
    title.textContent = words(failed ? "服务更新未通过检查" : "升级尚未确认恢复", failed ? "Service update checks failed" : "Update recovery is unconfirmed");
    const failure = state.failure;
    const validFailure = failure && ["health", "restart"].includes(failure.stage)
      && Number.isSafeInteger(failure.occurredAt) && failure.occurredAt > 0 && failure.occurredAt <= Date.now() + 60000;
    const reason = validFailure && Object.prototype.hasOwnProperty.call(reasons, failure.reason) ? reasons[failure.reason] : null;
    message.textContent = (failed ? reason ? words(...reason) : words("更新检查失败，具体原因未知。", "Update checks failed; the cause is unknown.")
      : words("更新状态已过期，尚未确认服务恢复。", "The update status expired; recovery is unconfirmed."))
      + (failed && validFailure ? words(" 发生时间：", " Occurred: ") + new Date(failure.occurredAt).toLocaleString() : "")
      + words(" 当前页面暂不可用，请重新检查；持续异常请联系管理员。", " This page is temporarily unavailable. Check again; contact an administrator if it continues.");
  } catch (error) {
    title.textContent = words("暂时无法获取服务状态", "Service status unavailable");
    message.textContent = error?.name === "TimeoutError" || error?.name === "AbortError"
      ? words("查询超时，请检查网络后重新检查；这不代表发布失败。", "The check timed out. Check your connection; this does not prove a deployment failure.")
      : words("无法读取服务状态，请检查网络后重新检查；这不代表发布失败。", "Could not read service status. Check your connection; this does not prove a deployment failure.");
  } finally {
    busy = false;
    retry.disabled = waiting;
    retry.textContent = words("重新检查", "Check again");
  }
}
retry.addEventListener("click", () => void check(true));
void check();
setInterval(() => { if (document.visibilityState === "visible") void check(); }, 3000);
