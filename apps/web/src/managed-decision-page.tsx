import { useCallback, useEffect, useRef, useState } from "react";
import type { ManagedDecision, ManagedDecisionGuard } from "@missiongo/domain";
import { api, ApiError, type ManagedDecisionView } from "./api";
import { localizedErrorText } from "./error-text";
import { useI18n } from "./i18n";
import { LoginForm } from "./login-form";
import "./managed-decision.css";

export function decisionGuard(d: ManagedDecision, idempotencyKey: string): ManagedDecisionGuard {
  return { version: d.version, stateVersion: d.stateVersion, contentDigest: d.contentDigest,
    scopeDigest: d.scopeDigest, contractRevision: d.scope.contractRevision, idempotencyKey };
}

export function decisionConfirmation(view: ManagedDecisionView): string {
  const d = view.decision;
  return JSON.stringify({ id: d.id, runId: d.runId, ...decisionGuard(d, ""), status: d.status,
    canApprove: view.access.canApprove, canRevoke: view.access.canRevoke });
}

export function DecisionDetails({ view }: { view: ManagedDecisionView }) {
  const { locale } = useI18n();
  const w = (zh: string, en: string) => locale === "en" ? en : zh;
  const d = view.decision;
  const status = { pending: w("待批准", "Pending"), approved: w("已批准", "Approved"), revoked: w("已撤销", "Revoked") };
  const actions = { implement: w("隔离开发", "Isolated implementation"), review: w("代码审查", "Code review"), verify: w("验证", "Verification") };
  return <>
    <header><p>{w("正式决策", "Formal decision")} · {w("版本", "Version")} {d.version} · {w("契约", "Contract")} {d.scope.contractRevision}</p>
      <h1>{d.content.title}</h1><strong data-testid="decision-status">{status[d.status]}</strong></header>
    <section aria-label={w("固定范围", "Frozen scope")}><h2>{w("固定范围", "Frozen scope")}</h2>
      <p>{view.productName} · {d.scope.repositoryRef}</p>
      <ul>{d.scope.itemKeys.map((key) => <li key={key}><a href={`/?${new URLSearchParams({ product: d.scope.productId, item: key })}`} target="_blank" rel="noopener noreferrer">
        {w("查看原条目 / 参与讨论", "View item / discuss")} · {key}</a></li>)}</ul>
      <p className="decision-note">{w("查看和讨论不构成批准。", "Reading and discussing do not grant approval.")}</p>
    </section>
    <section><h2>{w("允许动作", "Allowed actions")}</h2><ul>{d.content.allowedActions.map((action) => <li key={action}>{actions[action]}</li>)}</ul>
      <p className="decision-note">{w("不包含合并、发布或生产变更。批准不会自动启动任务。", "No merge, release or production changes. Approval does not start work.")}</p></section>
    <section><h2>{w("推荐方案", "Recommendation")}</h2><p>{d.content.recommendation}</p>
      <h2>{w("其他选项与代价", "Alternatives and trade-offs")}</h2><ul>{d.content.alternatives.map((text, i) => <li key={i}>{text}</li>)}</ul>
      <h2>{w("本方案代价", "Cost of this plan")}</h2><p>{d.content.costs}</p></section>
    <section><h2>{w("验收标准", "Acceptance criteria")}</h2><ol>{d.content.acceptanceCriteria.map((text, i) => <li key={i}>{text}</li>)}</ol></section>
    {d.explanation && <section><h2>{w("补充解释（不改变批准内容）", "Explanation (does not change approval)")}</h2><p>{d.explanation}</p></section>}
    {d.approval && <p>{w("批准人：当前账号；批准时间：", "Approved by the current account at: ")}<time dateTime={d.approval.approvedAt}>{new Date(d.approval.approvedAt).toLocaleString(locale)}</time></p>}
  </>;
}

export function ManagedDecisionPage() {
  const { t, locale } = useI18n();
  const w = (zh: string, en: string) => locale === "en" ? en : zh;
  const id = window.location.pathname.split("/")[2] ?? "";
  const [view, setView] = useState<ManagedDecisionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [issue, setIssue] = useState("");
  const [notice, setNotice] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const inFlight = useRef(false);
  const readSequence = useRef(0);
  const mounted = useRef(false);
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  const confirmed = view !== null && confirmation === decisionConfirmation(view);
  const readCurrent = useCallback(async (preserveIssue = false): Promise<boolean> => {
    const sequence = ++readSequence.current;
    setConfirmation(null);
    try {
      const value = await api.getManagedDecision(id);
      if (!mounted.current || sequence !== readSequence.current) return false;
      setView(value); setConfirmation(null); setSignedOut(false);
      if (!preserveIssue) setIssue("");
      return true;
    } catch (error) {
      if (!mounted.current || sequence !== readSequence.current) return false;
      setView(null); setConfirmation(null); setSignedOut(error instanceof ApiError && error.status === 401);
      if (!preserveIssue) setIssue(localizedErrorText(error, t));
      return false;
    }
  }, [id, t]);
  useEffect(() => {
    mounted.current = true;
    void readCurrent();
    return () => { mounted.current = false; };
  }, [readCurrent]);

  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setNotice("");
    try { await readCurrent(); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const confirm = async (operation: "approve" | "revoke") => {
    if (inFlight.current || !view || !confirmed || view.decision.id !== id
      || !(operation === "approve" ? view.access.canApprove && view.decision.status === "pending"
        : view.access.canRevoke && view.decision.status !== "revoked")) return;
    const d = view.decision;
    const fingerprint = `${decisionConfirmation(view)}:${operation}`;
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, key: crypto.randomUUID() };
    const input = decisionGuard(d, pending.current.key);
    // Invalidate older reads immediately, before the write has responded.
    readSequence.current++; setConfirmation(null);
    inFlight.current = true; setBusy(true); setNotice(""); setIssue("");
    try {
      if (operation === "approve") await api.approveManagedDecision(id, input);
      else await api.revokeManagedDecision(id, input);
      // Read back; a write receipt alone is not proof of the current state.
      if (await readCurrent()) setNotice(w("操作已记录；当前状态以页面回查为准。任务未自动启动。", "Recorded; the refreshed state is shown. No work was started."));
    } catch (error) {
      setIssue(error instanceof ApiError && error.status === 409
        ? w("决策已变化。请重新阅读并勾选确认；不会自动批准新版本。", "Decision changed. Review and confirm again; the new version is not approved automatically.")
        : w("操作未确认，已尝试回查。", "Outcome unconfirmed; a read-back was attempted. ") + localizedErrorText(error, t));
      await readCurrent(true);
    } finally { setConfirmation(null); inFlight.current = false; setBusy(false); }
  };
  return <main className="managed-decision-page">
    <nav><a href="/">{w("返回工作台", "Back to console")}</a></nav>
    {signedOut ? <section><h1>{w("登录后查看正式决策", "Sign in to view the decision")}</h1><LoginForm onAuthenticated={() => { void refresh(); }} /></section> : <>
      {view ? <DecisionDetails view={view} /> : !issue && <p role="status">{w("正在读取决策…", "Loading decision…")}</p>}
      {view && <section className="decision-actions" aria-label={w("正式操作", "Formal actions")}>
        <h2>{w("正式操作", "Formal actions")}</h2>
        <p>{w("只针对上方显示的版本。旧页面或权限变化会拒绝操作。", "Applies only to the version above. Stale pages and permission changes are rejected.")}</p>
        {(view.access.canApprove || view.access.canRevoke) && <label className="decision-confirm"><input type="checkbox" checked={confirmed} disabled={busy}
          onChange={(event) => setConfirmation(event.target.checked ? decisionConfirmation(view) : null)} />{w("我已核对当前版本的范围和允许动作", "I reviewed the scope and allowed actions of this version")}</label>}
        <div className="decision-buttons">
          {view.decision.status === "pending" && <button className="primary-button" disabled={busy || !confirmed || !view.access.canApprove} onClick={() => void confirm("approve")}>{w("批准当前版本", "Approve this version")}</button>}
          {view.access.canRevoke && <button className="secondary-button" disabled={busy || !confirmed} onClick={() => void confirm("revoke")}>{w("撤销批准", "Revoke approval")}</button>}
        </div>
        {!view.access.canApprove && !view.access.canRevoke && <p>{w("当前不可批准或撤销；不会自动执行。", "No approval or revocation is available; nothing runs automatically.")}</p>}
      </section>}
    </>}
    {issue && <p className="inline-error" role="alert">{issue}</p>}
    {notice && <p role="status">{notice}</p>}
    <button className="secondary-button" disabled={busy} onClick={() => void refresh()}>{w("重新读取状态", "Refresh state")}</button>
  </main>;
}
