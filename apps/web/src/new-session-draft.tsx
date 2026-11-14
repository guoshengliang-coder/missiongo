import { beginPerformanceSend, bindPerformanceSend, measurePerformance } from "./console-performance";
import { CommonCommandMenu, useCommandTarget } from "./common-commands";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, LoaderCircle, MessageSquare, Send } from "lucide-react";
import { api, ApiError } from "./api";
import { useI18n } from "./i18n";
import { agentLabelKey, dispatchProblemKey } from "./dispatch-eligibility";
import { localizedErrorText } from "./error-text";
import { agentModels, reconcileEffort } from "./agent-model-options";
import { modeProblem } from "./agent-mode-options";
import { AutoGrowTextarea } from "./auto-grow-textarea";
import { DraftSessionQuickSettings } from "./agent-session-settings";
import { DraftChatFile } from "./agent-chat-draft-file";
import { mergeChatFiles } from "./agent-chat-files";
import { useFileDropZone } from "./file-drop";
import { FileDropOverlay } from "./file-drop-overlay";
import type { Dispatch, FreeSessionConfig } from "./types";

export interface NewConversationDraft {
  config: FreeSessionConfig; text: string; files: File[];
  requestKey?: string; dispatch?: Dispatch; uploaded?: string[];
}

/** Parent owns drafts so Back, project switching and reopening never create empty history. */
export function NewSessionDraft({ draft, projectName, onChange, onBack, onConfigure, onPending, onStarted }: {
  draft: NewConversationDraft; projectName: string;
  onChange: (draft: NewConversationDraft) => void; onBack: () => void; onConfigure: () => void;
  onPending: (pending: boolean) => void; onStarted: (dispatch: Dispatch) => Promise<void>;
}) {
  const { t } = useI18n();
  const agentKey = agentLabelKey(draft.config.agentKind);
  const agentName = agentKey ? t(agentKey) : draft.config.agentKind;
  const picker = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [effortAdjusted, setEffortAdjusted] = useState(false);
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes });
  const node = nodes.data?.nodes.find(entry => entry.id === draft.config.nodeId);
  const models = agentModels(node, draft.config.agentKind);
  const { model: _model, effort: _effort, ...baseConfig } = draft.config;
  // An uncertain first response must retry the original reservation verbatim.
  // Catalog refreshes reconcile editable drafts, never a frozen request key.
  const config = draft.requestKey ? draft.config : { ...baseConfig, ...reconcileEffort(models, draft.config) };
  const modelUnavailable = Boolean(!draft.requestKey && config.model && models && !models.some(entry => entry.id === config.model));
  const catalogUnavailable = Boolean(!draft.requestKey && !models && (config.model || config.effort));
  const modeIssue = draft.requestKey ? undefined : modeProblem(config.agentKind, config.mode, node?.agents.find(agent => agent.kind === config.agentKind)?.modes, config.model);
  const configBlocked = modelUnavailable || catalogUnavailable || Boolean(modeIssue);
  const submitLock = useRef(false);
  const [phase, setPhase] = useState<"preparing" | "uploading" | "starting">("preparing");
  const [uploadIndex, setUploadIndex] = useState(0);
  const send = useMutation({ onSettled: () => { submitLock.current = false; }, mutationFn: async () => {
    setPhase("preparing");
    let sending = { ...draft, config, requestKey: draft.requestKey ?? crypto.randomUUID(), uploaded: [...(draft.uploaded ?? [])] };
    onChange(sending);
    const context={productId:sending.config.productId,agentKind:sending.config.agentKind,sendKind:"new_send"};
    beginPerformanceSend(sending.requestKey,context);
    let dispatch = sending.dispatch;
    if (!dispatch) {
      try {
        dispatch = await measurePerformance(context,sending.requestKey,"prepare",()=>api.prepareProjectConversation({ ...sending.config,
          requestKey: sending.requestKey, text: sending.text, attachmentCount: sending.files.length }));
      } catch (error) {
        // A rejected reservation created nothing. Keep content editable so the
        // person can repair the configuration; an uncertain response reuses its key.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.code !== "free_session_changed") {
          const { requestKey: _requestKey, ...editable } = draft;
          onChange(editable);
        }
        throw error;
      }
    }
    sending = { ...sending, dispatch };
    onChange(sending);
    if (!dispatch.agentSessionId) throw new Error(t("somethingWentWrong"));
    for (let index = sending.uploaded.length; index < sending.files.length; index++) {
      setPhase("uploading"); setUploadIndex(index + 1);
      const attachment = await measurePerformance(context,sending.requestKey,"upload",()=>api.uploadAgentSessionAttachment(dispatch!.agentSessionId!, sending.files[index]!, `${sending.requestKey}-${index}`));
      sending = { ...sending, uploaded: [...sending.uploaded, attachment.id] };
      onChange(sending);
    }
    setPhase("starting");
    const started = await measurePerformance(context,sending.requestKey,"start",()=>api.startProjectConversation(dispatch!.id, sending.uploaded));
    const initial=started as Dispatch & {performanceCommandId?:string};
    if(initial.performanceCommandId&&initial.agentSessionId)bindPerformanceSend(sending.requestKey,initial.performanceCommandId,initial.agentSessionId);
    await onStarted(started);
  } });
  const problemKey = send.error instanceof ApiError ? dispatchProblemKey(send.error.code) : null;
  const errorText = problemKey ? t(problemKey, { agent: agentName, reason: send.error?.message ?? "" }) : localizedErrorText(send.error, t);
  useEffect(() => { onPending(send.isPending); return () => onPending(false); }, [send.isPending, onPending]);
  const locked = send.isPending || Boolean(draft.requestKey);
  useEffect(() => {
    if (locked || draft.config.effort === config.effort) return;
    onChange({ ...draft, config: { ...config, saveAsDefault: false } });
    setEffortAdjusted(true);
  }, [locked, draft, config, onChange]);
  const addFiles = (incoming: readonly File[]) => {
    if (locked || !draft.config.canAttach) return;
    const result = mergeChatFiles(draft.files, incoming);
    if (result.rejection) {
      setFileError(result.rejection.reason === "too-many" ? t("agentChatTooManyFiles")
        : t("agentChatInvalidFile", { filename: result.rejection.filename }));
    } else { setFileError(null); onChange({ ...draft, files: result.files }); }
  };
  const { isDraggingFiles, dropHandlers } = useFileDropZone(addFiles, { canAccept: !locked && Boolean(draft.config.canAttach) });
  const commandUndo = useCommandTarget("new-session",draft.text,text=>onChange({...draft,text}),locked);
  return <>
    <header className="agent-console-conversation-head new-session-head">
      <button type="button" className="icon-button" aria-label={t("agentConsoleBackToSessions")} disabled={send.isPending} onClick={onBack}><ArrowLeft size={19} /></button>
      <div className="agent-console-heading"><h2>{t("newSession")}</h2>
        <small>{projectName} · {agentName} · {draft.config.nodeName}</small></div>
      <button type="button" className="secondary-button" disabled={locked} onClick={onConfigure}>{t("newSessionConfigure")}</button>
    </header>
    <div className="agent-console-empty agent-console-empty-conversation"><MessageSquare size={24} /><p>{t("newSessionEmpty")}</p></div>
    <footer className="agent-console-reply">
      <form onSubmit={event => { event.preventDefault(); if (!submitLock.current && !send.isPending && !configBlocked && (!draft.files.length || draft.config.canAttach) && (draft.text.trim() || draft.files.length)) { submitLock.current = true; send.mutate(); } }} {...dropHandlers}>
        {isDraggingFiles && <FileDropOverlay remaining={10 - draft.files.length} />}
        <AutoGrowTextarea data-command-target="new-session" autoFocus submitOnEnter rows={2} value={draft.text} maxLength={20000} disabled={locked}
          aria-label={t("agentSessionReplyPlaceholder", { agent: agentName })}
          placeholder={t("agentSessionReplyPlaceholder", { agent: agentName })}
          onChange={event => onChange({ ...draft, text: event.target.value })}
          onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); addFiles(files); } }} />
        {commandUndo}
        {draft.files.length > 0 && <div className="agent-chat-draft-files">{draft.files.map((file, index) =>
          <DraftChatFile key={index} file={file} disabled={locked} onReplace={(original, annotated) => onChange({ ...draft, files: draft.files.map((entry, fileIndex) => fileIndex === index && entry === original ? annotated : entry) })} onRemove={() => onChange({ ...draft, files: draft.files.filter((_, i) => i !== index) })} />)}</div>}
        {draft.files.length > 0 && !draft.config.canAttach && <p className="inline-error" role="alert">{t("agentChatNodeUpdate")}</p>}
        {fileError && <p className="inline-error" role="alert">{fileError}</p>}
        {send.isError && <p className="inline-error" role="alert">{errorText}</p>}
        {send.isPending && <p className="agent-session-muted" role="status">{phase === "uploading"
          ? t("agentSendUploading", { current: uploadIndex, total: draft.files.length })
          : t(phase === "preparing" ? "agentSendPreparing" : "agentSendStarting")}</p>}
        {modelUnavailable && <p className="inline-error" role="alert">{t("dispatchModelUnavailable", { model: config.model! })}</p>}
        {catalogUnavailable && <p className="inline-error" role="alert">{t("dispatchModelUnsupported")}</p>}
        {modeIssue && <p className="inline-error" role="alert">{t(modeIssue)}</p>}
        {effortAdjusted && <p className="dispatch-note" role="status">{t("dispatchEffortReset", { model: models?.find(entry => entry.id === config.model)?.label ?? (config.model || t("dispatchModelLocal")) })}</p>}
        <div className="agent-console-reply-actions">
          <DraftSessionQuickSettings config={config} disabled={locked} onChange={next => { setEffortAdjusted(false); onChange({ ...draft, config: { ...next, saveAsDefault: false } }); }} />
          <div className="agent-chat-send-actions">
            <input ref={picker} type="file" multiple hidden accept=".png,.jpg,.jpeg,.webp,.gif,.heic,.mp4,.mov,.webm,.log,.txt,.json,.md,.csv,.pdf"
              onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            <CommonCommandMenu targetId="new-session" disabled={locked} onUpload={kind=>{const input=picker.current;if(input){input.accept=kind==="image"?".png,.jpg,.jpeg,.webp,.gif,.heic":".png,.jpg,.jpeg,.webp,.gif,.heic,.mp4,.mov,.webm,.log,.txt,.json,.md,.csv,.pdf";input.click()}}} uploadDisabled={!draft.config.canAttach} />
            <button type="submit" className="primary-button agent-chat-icon-button" disabled={send.isPending || configBlocked || (draft.files.length > 0 && !draft.config.canAttach) || (!draft.text.trim() && !draft.files.length)}
              aria-label={t(send.isError ? "retry" : "agentSessionSend")}>
              {send.isPending ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
            </button>
          </div>
        </div>
        <small className="agent-session-muted">{t("newSessionDraftHint")}</small>
      </form>
    </footer>
  </>;
}
