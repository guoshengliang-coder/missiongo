import { type ChangeEvent, type FormEvent, useEffect, useState } from "react";
import { Bug, Check, ChevronRight, FileText, Highlighter, Image as ImageIcon, Lightbulb, ListTodo, LoaderCircle, Paperclip, StickyNote } from "lucide-react";

import "./sdk-feedback.css";
import { loadSdkAttachments, replaceSdkAttachments, type StoredSdkAttachment } from "./sdk-attachment-store";
import { ImageAnnotator } from "./ImageAnnotator";
import { isAnnotatableImage } from "./image-annotation";
import { useI18n } from "./i18n";
import type { WorkItemPriority, WorkItemType } from "./types";

type SubmissionTarget = "inbox" | "ready";

interface FeedbackDraft {
  readonly id: string;
  readonly status: "editing" | "submitted" | "expired";
  readonly title: string;
  readonly description: string;
  readonly type: WorkItemType;
  readonly priority: WorkItemPriority;
  readonly environment: Readonly<Record<string, unknown>>;
  readonly context: Readonly<Record<string, string>>;
  readonly logs: readonly { readonly timestamp: string; readonly level: string; readonly message: string }[];
  readonly itemKey?: string;
}

const TYPES: readonly WorkItemType[] = ["idea", "requirement", "bug", "task", "note"];
const PRIORITIES: readonly WorkItemPriority[] = ["urgent", "high", "normal", "low"];
const TYPE_ICONS = {
  idea: Lightbulb,
  requirement: FileText,
  bug: Bug,
  task: ListTodo,
  note: StickyNote,
} as const;

function isDiagnosticFile(file: File): boolean {
  const extension = file.name.split(".").pop()?.toLowerCase();
  return file.type === "text/plain" || file.type === "application/json" || extension === "log" || extension === "txt" || extension === "json";
}

function feedbackContextEntries(draft: FeedbackDraft): readonly [string, string][] {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(draft.environment)) {
    if (key === "metadata" && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [metadataKey, metadataValue] of Object.entries(value)) {
        entries.push([metadataKey, String(metadataValue)]);
      }
    } else if (value !== undefined && value !== null && value !== "") {
      entries.push([key, String(value)]);
    }
  }
  entries.push(...Object.entries(draft.context));
  return entries;
}

async function sdkRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as { title?: string } | null;
    throw new Error(problem?.title ?? `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

function attachmentId(index: number): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2)}`;
}

async function uploadAttachment(draftId: string, attachment: StoredSdkAttachment): Promise<void> {
  const { file } = attachment;
  const response = await fetch(`/api/v1/sdk/drafts/${encodeURIComponent(draftId)}/attachments`, {
    method: "POST",
    credentials: "include",
    headers: {
      accept: "application/json",
      "content-type": "application/octet-stream",
      "x-missiongo-filename": encodeURIComponent(file.name),
      "x-missiongo-content-type": file.type || "application/octet-stream",
      "x-missiongo-client-attachment-id": attachment.id,
    },
    body: file,
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as { title?: string } | null;
    throw new Error(problem?.title ?? `Attachment upload failed (${response.status}).`);
  }
}

export function SdkFeedbackPage() {
  const { priorityLabel, t, typeLabel } = useI18n();
  const parameters = new URL(window.location.href).searchParams;
  const draftId = parameters.get("draft")?.trim() ?? "";
  const completedItemKey = parameters.get("item")?.trim() ?? "";
  const completedDestination: SubmissionTarget = parameters.get("destination") === "ready" ? "ready" : "inbox";
  const [draft, setDraft] = useState<FeedbackDraft | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<WorkItemType>("bug");
  const [priority, setPriority] = useState<WorkItemPriority>("normal");
  const [includeLogs, setIncludeLogs] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [itemKey, setItemKey] = useState(completedItemKey);
  const [destination, setDestination] = useState<SubmissionTarget>(completedDestination);
  const [files, setFiles] = useState<readonly StoredSdkAttachment[]>([]);
  const [failedFiles, setFailedFiles] = useState<readonly StoredSdkAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [annotatingId, setAnnotatingId] = useState<string | null>(null);

  useEffect(() => {
    if (completedItemKey) return;
    if (!draftId) {
      setError("Missing feedback draft.");
      return;
    }
    void sdkRequest<FeedbackDraft>(`/api/v1/sdk/drafts/${encodeURIComponent(draftId)}`)
      .then((loaded) => {
        setDraft(loaded);
        setTitle(loaded.title);
        setDescription(loaded.description);
        setType(loaded.type);
        setPriority(loaded.priority);
        void loadSdkAttachments(loaded.id)
          .then(setFiles)
          .catch(() => setAttachmentError(t("sdkDraftFilesLost")));
        if (loaded.status === "submitted" && loaded.itemKey) {
          window.location.replace(`/sdk/feedback/complete?item=${encodeURIComponent(loaded.itemKey)}&destination=inbox`);
        }
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Could not load feedback."));
  }, [completedItemKey, draftId]);

  const submit = async (target: SubmissionTarget) => {
    if (!draft || !title.trim()) return;
    setSubmitting(true);
    setDestination(target);
    setError("");
    try {
      await sdkRequest<FeedbackDraft>(`/api/v1/sdk/drafts/${encodeURIComponent(draft.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ title, description, type, priority, logs: includeLogs ? draft.logs : [] }),
      });
      const submitted = await sdkRequest<FeedbackDraft>(`/api/v1/sdk/drafts/${encodeURIComponent(draft.id)}/finalize`, {
        method: "POST",
        body: JSON.stringify({ status: target }),
      });
      if (!submitted.itemKey) throw new Error("MissionGo did not return an item key.");
      const uploads = await Promise.allSettled(files.map((file) => uploadAttachment(draft.id, file)));
      const failed = files.filter((_file, index) => uploads[index]?.status === "rejected");
      await replaceSdkAttachments(draft.id, failed).catch(() => undefined);
      setFailedFiles(failed);
      setAttachmentError(failed.length > 0 ? t("sdkUploadsFailed", { count: failed.length }) : "");
      setItemKey(submitted.itemKey);
      if (failed.length === 0) {
        window.location.replace(`/sdk/feedback/complete?item=${encodeURIComponent(submitted.itemKey)}&destination=${target}`);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not submit feedback.");
    } finally {
      setSubmitting(false);
    }
  };

  const selectFiles = (kind: "media" | "log") => (event: ChangeEvent<HTMLInputElement>) => {
    const preserved = files.filter(({ file }) => kind === "media" ? isDiagnosticFile(file) : !isDiagnosticFile(file));
    const available = Math.max(0, 10 - preserved.length);
    const incoming = Array.from(event.target.files ?? []).slice(0, available);
    const selected = incoming.map((file, index) => ({ id: attachmentId(index), file }));
    const next = kind === "media" ? [...selected, ...preserved] : [...preserved, ...selected];
    setFiles(next);
    setAttachmentError((event.target.files?.length ?? 0) > available ? t("sdkTooManyFiles") : "");
    if (draft) {
      void replaceSdkAttachments(draft.id, next)
        .catch(() => setAttachmentError(t("sdkAttachmentsNotPersisted")));
    }
    event.target.value = "";
  };

  // Annotating happens before anything is uploaded, so it only has to swap the
  // file held in state and mirror that into the recovery store.
  const saveAnnotation = async (id: string, annotated: File) => {
    const next = files.map((current) => current.id === id ? { ...current, file: annotated } : current);
    setFiles(next);
    setAnnotatingId(null);
    if (draft) {
      await replaceSdkAttachments(draft.id, next)
        .catch(() => setAttachmentError(t("sdkAttachmentsNotPersisted")));
    }
  };

  const retryFailedAttachments = async () => {
    if (!draft || failedFiles.length === 0) return;
    setSubmitting(true);
    setAttachmentError("");
    const uploads = await Promise.allSettled(failedFiles.map((file) => uploadAttachment(draft.id, file)));
    const remaining = failedFiles.filter((_file, index) => uploads[index]?.status === "rejected");
    await replaceSdkAttachments(draft.id, remaining).catch(() => undefined);
    setFailedFiles(remaining);
    setAttachmentError(remaining.length > 0 ? t("sdkUploadsStillFailing", { count: remaining.length }) : "");
    setSubmitting(false);
    if (remaining.length === 0) {
      window.location.replace(`/sdk/feedback/complete?item=${encodeURIComponent(itemKey)}&destination=${destination}`);
    }
  };

  if (itemKey) return <main className="sdk-feedback-page"><section className="sdk-feedback-dialog sdk-feedback-complete"><span><Check size={28} /></span><h1>{t(destination === "ready" ? "sdkSubmittedReady" : "sdkSavedDraft")}</h1><p>{t("sdkItemKey")}</p><code>{itemKey}</code>{attachmentError && <div className="sdk-feedback-error" role="alert">{attachmentError}</div>}{failedFiles.length > 0 ? <button className="primary-button" type="button" disabled={submitting} onClick={() => void retryFailedAttachments()}>{submitting ? <LoaderCircle className="spin" size={17} /> : null}{submitting ? t("sdkRetrying") : t("sdkRetryFailed")}</button> : <a className="primary-button sdk-feedback-return" href="missiongo-feedback://close">{t("sdkReturn")}</a>}</section></main>;

  if (!draft && !error) return <main className="sdk-feedback-page"><section className="sdk-feedback-dialog sdk-feedback-loading"><LoaderCircle className="spin" size={22} /><p>{t("sdkPreparingForm")}</p></section></main>;

  const selectedMedia = files.filter(({ file }) => !isDiagnosticFile(file));
  const selectedLogs = files.filter(({ file }) => isDiagnosticFile(file));
  const contextEntries = draft ? feedbackContextEntries(draft) : [];

  return (
    <main className="sdk-feedback-page">
      <section className="sdk-feedback-dialog">
        <header className="sdk-feedback-header"><p>MissionGo</p><h1>{t("sdkFeedbackTitle")}</h1><span>{t("sdkFeedbackIntro")}</span></header>
        {error && <div className="sdk-feedback-error" role="alert">{error}</div>}
        {attachmentError && <div className="sdk-feedback-error" role="alert">{attachmentError}</div>}
        {draft && (
          <form className="capture-form quick-capture-form sdk-feedback-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void submit("inbox"); }}>
            <div className="capture-type-grid" aria-label={t("type")}>
              {TYPES.map((value) => {
                const Icon = TYPE_ICONS[value];
                return <button key={value} type="button" className={`capture-type ${type === value ? "active" : ""} type-${value}`} onClick={() => setType(value)}><Icon size={16} />{typeLabel(value)}</button>;
              })}
            </div>
            <div className="classification-row">
              <label><span className="field-label">{t("platform")}<span className="field-requirement required">{t("requiredField")}</span></span><input value="Android" readOnly /></label>
              <label><span className="field-label">{t("sdkSourceModule")}</span><input value="MissionGo" readOnly /></label>
              <label><span className="field-label">{t("priority")}</span><select value={priority} onChange={(event) => setPriority(event.target.value as WorkItemPriority)}>{PRIORITIES.map((value) => <option key={value} value={value}>{priorityLabel(value)}</option>)}</select></label>
            </div>
            <label><span className="field-label">{t("whatNeedsAttention")}<span className="field-requirement required">{t("requiredField")}</span></span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={500} placeholder={t("clearSpecificTitle")} required autoFocus /></label>
            <section className="attachment-picker-block capture-attachment-block">
              <div className="capture-attachment-heading">
                <div className="capture-attachment-copy"><strong><span className="field-label">{t("mediaAttachments")}</span></strong><p>{t("sdkMediaHelp")}</p></div>
                <label className="secondary-button sdk-feedback-picker"><ImageIcon size={16} /> {t("add")}<input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,image/heic,video/mp4,video/quicktime,video/webm" onChange={selectFiles("media")} /></label>
              </div>
              {selectedMedia.length > 0 && <div className="sdk-feedback-selected">{selectedMedia.map(({ id, file }) => (
                <span key={id}>
                  <ImageIcon size={14} /><strong>{file.name}</strong>
                  {isAnnotatableImage(file) && (
                    <button type="button" onClick={() => setAnnotatingId(id)} aria-label={t("annotateImage")} title={t("annotate")}><Highlighter size={13} /></button>
                  )}
                </span>
              ))}</div>}
            </section>
            <section className="report-input-block">
              <header><strong>{t("sdkReportHeading")}</strong><small>{t("sdkReportHelp")}</small></header>
              <label><span className="field-label">{t("sdkWhatHappened")}<span className="field-requirement required">{t("requiredField")}</span></span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={20_000} rows={6} placeholder={t("sdkWhatHappenedPlaceholder")} required /></label>
            </section>
            <section className="diagnostic-input-block">
              <div className="diagnostic-input-heading">
                <span><strong>{t("diagnostics")}</strong><small>{t("sdkDiagnosticsHelp")}</small></span>
                <label className="secondary-button sdk-feedback-picker"><Paperclip size={16} /> {t("uploadLog")}<input type="file" multiple accept=".log,.txt,.json,text/plain,application/json" onChange={selectFiles("log")} /></label>
              </div>
              {selectedLogs.length > 0 && <div className="sdk-feedback-selected">{selectedLogs.map(({ id, file }) => <span key={id}><FileText size={14} /><strong>{file.name}</strong></span>)}</div>}
              {draft.logs.length > 0 && <label className="sdk-feedback-check"><input type="checkbox" checked={includeLogs} onChange={(event) => setIncludeLogs(event.target.checked)} /><span>{t("sdkIncludeHostLogs", { count: draft.logs.length })}</span></label>}
              {draft.logs.length === 0 && <p className="sdk-feedback-empty-log">{t("sdkNoHostLogs")}</p>}
            </section>
            <details className="capture-optional">
              <summary><ChevronRight size={16} /><span><strong>{t("sdkAutoIncluded")}</strong><small>{t("sdkAutoIncludedHelp")}</small></span></summary>
              <div className="capture-optional-body"><dl className="sdk-feedback-context">{contextEntries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></div>
            </details>
            <p className="privacy-note">{t("sdkPrivacyNote")}</p>
            <div className="form-footer sdk-feedback-actions">
              <button className="secondary-button" type="submit" disabled={submitting || !title.trim()}>{submitting && destination === "inbox" ? <LoaderCircle className="spin" size={17} /> : <FileText size={17} />}{t(submitting && destination === "inbox" ? "sdkSaving" : "sdkSaveDraft")}</button>
              <button className="primary-button" type="button" disabled={submitting || !title.trim() || !description.trim()} onClick={() => void submit("ready")}>{submitting && destination === "ready" ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{t(submitting && destination === "ready" ? "sdkSubmitting" : "sdkSubmitReady")}</button>
            </div>
          </form>
        )}
      </section>
      {annotatingId && files.some((current) => current.id === annotatingId) && (
        <ImageAnnotator
          file={files.find((current) => current.id === annotatingId)!.file}
          onCancel={() => setAnnotatingId(null)}
          onSave={(annotated) => saveAnnotation(annotatingId, annotated)}
        />
      )}
    </main>
  );
}
