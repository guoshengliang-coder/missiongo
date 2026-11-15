import type { DesktopUpdate } from "./contracts.js";

/** Download cancellation and validation are separate stages; late events cannot authorize installation. */
export class DesktopUpdates {
  private value: DesktopUpdate = { state: "idle" };
  private cancelDownload: (() => void) | undefined;
  get snapshot(): DesktopUpdate { return { ...this.value }; }
  get active(): boolean { return this.cancelDownload !== undefined; }
  checking() { if (this.active) throw new Error("更新仍在进行，请先等待或取消下载"); this.value = { state: "checking" }; }
  available(version: string, notes?: unknown) { if (!this.active) this.value = { state: "available", version, ...(typeof notes === "string" && notes.length <= 20000 ? {notes} : {}) }; }
  current() { if (!this.active) this.value = { state: "current" }; }
  begin(cancel: () => void) {
    if (this.active || !["available", "cancelled", "failed"].includes(this.value.state) || !this.value.version) throw new Error("请先检查并确认可用更新");
    delete this.value.error;
    this.cancelDownload = cancel; this.value = { ...this.value, state: "downloading", percent: 0 };
  }
  progress(value: { percent: number; transferred: number; total: number }) {
    if (this.value.state !== "downloading" || ![value.percent, value.transferred, value.total].every(Number.isFinite)) return;
    this.value = { ...this.value, percent: Math.max(0, Math.min(100, value.percent)), transferred: Math.max(0, value.transferred), total: Math.max(0, value.total) };
  }
  verifying(): boolean {
    if (this.value.state !== "downloading") return false;
    this.value = { ...this.value, state: "verifying" }; return true;
  }
  verified(trusted: boolean) {
    if (this.value.state !== "verifying") return;
    this.value = { ...this.value, state: trusted ? "ready" : "failed", version: this.value.version, ...(trusted ? {} : { error: "更新包签名身份校验失败，未安装" }) };
  }
  cancel() {
    if (this.value.state !== "downloading") throw new Error("当前阶段不能取消，请等待校验或安装结果");
    this.value = { ...this.value, state: "cancelling" }; this.cancelDownload?.();
  }
  failed() { if (this.value.state !== "cancelling") this.value = { ...this.value, state: "failed", version: this.value.version, error: "更新检查或下载失败，可稍后重试" }; }
  settled(error = false) {
    if (this.value.state === "cancelling") this.value = { ...this.value, state: "cancelled", version: this.value.version };
    else if (error || ["downloading", "verifying"].includes(this.value.state)) this.failed();
    this.cancelDownload = undefined;
  }
  installing() { if (this.value.state !== "ready") throw new Error("更新尚未完成签名校验"); this.value = { ...this.value, state: "installing" }; }
  deferInstall() { if (this.value.state === "installing") this.value = { ...this.value, state: "ready" }; }
}
