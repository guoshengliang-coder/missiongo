import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { api } from "./api";
import { Modal } from "./modal";
import { useI18n } from "./i18n";
import type { AgentSession, AgentSessionCommand } from "./types";

export function isWriterOccupied(error: string | undefined) {
  return Boolean(error && /already has an active writer/i.test(error));
}
export function writerFailure(command: AgentSessionCommand | undefined) {
  return command?.kind === "message" && command.status === "failed" && isWriterOccupied(command.error);
}
export function readinessIsCurrent(session: AgentSession, command: AgentSessionCommand, requestedAt: string, now = Date.now()) {
  const check = session.turnState?.replyReadiness;
  const at = Date.parse(check?.checkedAt ?? "");
  const exhausted = ["codex_context_window_exceeded", "codex_session_budget_exceeded"].includes(session.failure?.code ?? "");
  return check?.state === "ready" && session.canReply && !session.archivedAt && !exhausted
    && ["idle", "failed"].includes(session.status)
    && session.turnState?.turnActive !== true && at >= Date.parse(requestedAt) && at >= Date.parse(command.createdAt)
    && at <= now + 1000 && now - at < 30_000;
}

/** Shared by both chat entrances. Checks only request source observations;
 * retry uses the ordinary sender, with a fresh idempotent send request. */
export function AgentWriterRecovery({session, command, nodeName, blocked, onRetry}: {
  session: AgentSession; command: AgentSessionCommand; nodeName?: string | undefined; blocked: boolean;
  onRetry: (files: readonly File[]) => Promise<unknown>;
}) {
  const {t} = useI18n(); const client = useQueryClient();
  const [guide, setGuide] = useState(false); const [busy, setBusy] = useState(false);
  const [requestedAt, setRequestedAt] = useState("");
  const [result, setResult] = useState<"occupied" | "unknown" | "unsupported" | "failed" | undefined>();
  const [message, setMessage] = useState<string>();
  const gate = useRef(false); const generation = useRef(0); const mounted = useRef(true);
  const latest = useRef({session, command, requestedAt, blocked, onRetry});
  latest.current = {session, command, requestedAt, blocked, onRetry};
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; generation.current++;};}, []);
  const ready = Boolean(requestedAt && readinessIsCurrent(session, command, requestedAt));
  useEffect(() => {
    if (!requestedAt) return;
    const timer = setTimeout(() => {setRequestedAt(""); setResult("unknown");}, 30_000);
    return () => clearTimeout(timer);
  }, [requestedAt]);
  const check = async () => {
    if (gate.current || blocked) return;
    gate.current = true; setBusy(true); setMessage(undefined); setRequestedAt("");
    const run = ++generation.current;
    try {
      const request = await api.checkAgentConnection(session.id);
      if (!mounted.current || generation.current !== run) return;
      if (!request.supported) {setResult("unsupported"); return;}
      setRequestedAt(request.requestedAt);
      for (let n = 0; n < 8; n++) {
        if (n) await new Promise(resolve => setTimeout(resolve, 1500));
        if (!mounted.current || generation.current !== run) return;
        const data = await api.getAgentSession(session.id);
        if (!mounted.current || generation.current !== run) return;
        client.setQueryData(["agent-session", session.id], data);
        const observation = data.turnState?.replyReadiness;
        if (Date.parse(observation?.checkedAt ?? "") >= Date.parse(request.requestedAt)) {
          setResult(observation?.state === "occupied" ? "occupied" : "unknown");
          if (readinessIsCurrent(data, command, request.requestedAt)) setGuide(false);
          return;
        }
      }
      setResult("unknown");
    } catch { if (mounted.current && generation.current === run) setResult("failed"); }
    finally { if (mounted.current && generation.current === run) {gate.current = false; setBusy(false);} }
  };
  const retry = async () => {
    if (gate.current || blocked || !requestedAt || !readinessIsCurrent(session, command, requestedAt)) return;
    gate.current = true; setBusy(true); setMessage(undefined);
    try {
      // Download all originals first. A missing attachment must never become a text-only retry.
      const files = await Promise.all((command.attachments ?? []).map(async attachment => {
        const response = await fetch(api.agentSessionAttachmentUrl(session.id, attachment.id), {credentials: "same-origin"});
        if (!response.ok) throw new Error("Attachment unavailable");
        return new File([await response.blob()], attachment.filename, {type: attachment.contentType});
      }));
      if (!mounted.current) return;
      const current = latest.current;
      // Attachment reads can outlive the observation or a permission/status change.
      // Never send from the pre-download closure after that gate has closed.
      if (current.blocked || current.session.id !== session.id || current.command.id !== command.id
        || current.requestedAt !== requestedAt || !readinessIsCurrent(current.session, current.command, current.requestedAt)) {
        setRequestedAt(""); setResult("unknown"); return;
      }
      await current.onRetry(files);
    } catch { if (mounted.current) setMessage(t("agentWriterRetryFailed")); }
    finally { if (mounted.current) {gate.current = false; setBusy(false);} }
  };
  const copy = async () => {
    try {await navigator.clipboard.writeText(command.error ?? "");setMessage(t("copied"));}
    catch {setMessage(t("agentWriterCopyFailed"));}
  };
  const status = ready ? undefined : result;
  return <>
    <section className={`agent-writer-recovery${ready ? " recovered" : ""}`} aria-label={t("agentWriterTitle")}>
      <strong>{ready ? <CircleCheck size={18} /> : <CircleAlert size={18} />}{t(ready ? "agentWriterReady" : "agentWriterTitle")}</strong>
      <p>{t(ready ? "agentWriterReadyDetail" : "agentWriterOccupied", {node: nodeName ?? t("agentWriterSourceComputer")})}</p>
      <p>{t("agentWriterPreserved")}</p>
      <div className="agent-writer-actions">
        {ready ? <button type="button" className="primary-button" disabled={busy || blocked} onClick={() => void retry()}>{busy && <LoaderCircle className="spin" size={14} />}{t("agentWriterRetry")}</button>
          : <><button type="button" className="primary-button" disabled={busy || blocked} onClick={() => void check()}>{busy && <LoaderCircle className="spin" size={14} />}{t(busy ? "agentWriterChecking" : "agentWriterCheck")}</button>
          <button type="button" className="secondary-button" onClick={() => setGuide(true)}>{t("agentWriterGuide")}</button></>}
      </div>
      {status && <p role="status">{t(status === "occupied" ? "agentWriterStillOccupied" : status === "unsupported" ? "agentWriterUnsupported" : status === "failed" ? "agentWriterCheckFailed" : "agentWriterUnknown")}</p>}
      {message && <p role="status">{message}</p>}
      <details><summary>{t(ready ? "agentWriterPreviousDetails" : "agentWriterDetails")}</summary><pre>{command.error}</pre><button type="button" className="text-button" onClick={() => void copy()}>{t("agentWriterCopy")}</button></details>
    </section>
    {guide && <Modal title={t("agentWriterRestore")} subtitle="" onClose={() => setGuide(false)}>
      <p>{t("agentWriterGuideNode", {node: nodeName ?? t("agentWriterSourceComputer")})}</p>
      <ol className="agent-writer-steps"><li>{t("agentWriterStep1")}</li><li>{t("agentWriterStep2")}</li><li>{t("agentWriterStep3")}</li></ol>
      <p className="account-note">{t("agentWriterQuitWarning")}</p>
      <div className="form-footer"><button type="button" className="primary-button" disabled={busy || blocked} onClick={() => void check()}>{t(busy ? "agentWriterChecking" : "agentWriterCheck")}</button></div>
      <p>{t("agentWriterCheckOnly")}</p>
      {status && <p role="status">{t(status === "occupied" ? "agentWriterStillOccupied" : status === "unsupported" ? "agentWriterUnsupported" : status === "failed" ? "agentWriterCheckFailed" : "agentWriterUnknown")}</p>}
    </Modal>}
  </>;
}
