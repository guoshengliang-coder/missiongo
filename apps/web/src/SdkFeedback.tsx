import { type ChangeEvent, type FormEvent, useEffect, useState } from "react";
import { Bug, Check, ChevronRight, FileText, Image as ImageIcon, Lightbulb, ListTodo, LoaderCircle, Paperclip, StickyNote } from "lucide-react";

import "./sdk-feedback.css";
import { loadSdkAttachments, replaceSdkAttachments, type StoredSdkAttachment } from "./sdk-attachment-store";

type WorkItemType = "idea" | "requirement" | "bug" | "task" | "note";
type WorkItemPriority = "urgent" | "high" | "normal" | "low";
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
const TYPE_LABELS: Readonly<Record<WorkItemType, string>> = {
  idea: "想法",
  requirement: "需求",
  bug: "问题",
  task: "任务",
  note: "记录",
};
const PRIORITY_LABELS: Readonly<Record<WorkItemPriority, string>> = {
  urgent: "紧急",
  high: "高",
  normal: "普通",
  low: "低",
};
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
          .catch(() => setAttachmentError("无法恢复此前选择的附件，请重新选择。"));
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
      setAttachmentError(failed.length > 0 ? `${failed.length} 个附件上传失败，任务已创建，可在本页重试。` : "");
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
    setAttachmentError((event.target.files?.length ?? 0) > available ? "每次反馈最多选择 10 个附件。" : "");
    if (draft) {
      void replaceSdkAttachments(draft.id, next)
        .catch(() => setAttachmentError("附件无法持久保存，请保持当前页面打开直至提交完成。"));
    }
    event.target.value = "";
  };

  const retryFailedAttachments = async () => {
    if (!draft || failedFiles.length === 0) return;
    setSubmitting(true);
    setAttachmentError("");
    const uploads = await Promise.allSettled(failedFiles.map((file) => uploadAttachment(draft.id, file)));
    const remaining = failedFiles.filter((_file, index) => uploads[index]?.status === "rejected");
    await replaceSdkAttachments(draft.id, remaining).catch(() => undefined);
    setFailedFiles(remaining);
    setAttachmentError(remaining.length > 0 ? `${remaining.length} 个附件仍未上传成功，请稍后重试。` : "");
    setSubmitting(false);
    if (remaining.length === 0) {
      window.location.replace(`/sdk/feedback/complete?item=${encodeURIComponent(itemKey)}&destination=${destination}`);
    }
  };

  if (itemKey) return <main className="sdk-feedback-page"><section className="sdk-feedback-dialog sdk-feedback-complete"><span><Check size={28} /></span><h1>{destination === "ready" ? "已提交到待处理" : "已保存到草稿"}</h1><p>任务编号</p><code>{itemKey}</code>{attachmentError && <div className="sdk-feedback-error" role="alert">{attachmentError}</div>}{failedFiles.length > 0 ? <button className="primary-button" type="button" disabled={submitting} onClick={() => void retryFailedAttachments()}>{submitting ? <LoaderCircle className="spin" size={17} /> : null}{submitting ? "正在重试…" : "重试失败附件"}</button> : <a className="primary-button sdk-feedback-return" href="missiongo-feedback://close">返回 MissionGo</a>}</section></main>;

  if (!draft && !error) return <main className="sdk-feedback-page"><section className="sdk-feedback-dialog sdk-feedback-loading"><LoaderCircle className="spin" size={22} /><p>正在准备反馈表单…</p></section></main>;

  const selectedMedia = files.filter(({ file }) => !isDiagnosticFile(file));
  const selectedLogs = files.filter(({ file }) => isDiagnosticFile(file));
  const contextEntries = draft ? feedbackContextEntries(draft) : [];

  return (
    <main className="sdk-feedback-page">
      <section className="sdk-feedback-dialog">
        <header className="sdk-feedback-header"><p>MissionGo</p><h1>记录工作</h1><span>添加到 MissionGo。Android SDK 已经预填当前运行环境，请补充实际现象与期望结果。</span></header>
        {error && <div className="sdk-feedback-error" role="alert">{error}</div>}
        {attachmentError && <div className="sdk-feedback-error" role="alert">{attachmentError}</div>}
        {draft && (
          <form className="capture-form quick-capture-form sdk-feedback-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void submit("inbox"); }}>
            <div className="capture-type-grid" aria-label="类型">
              {TYPES.map((value) => {
                const Icon = TYPE_ICONS[value];
                return <button key={value} type="button" className={`capture-type ${type === value ? "active" : ""} type-${value}`} onClick={() => setType(value)}><Icon size={16} />{TYPE_LABELS[value]}</button>;
              })}
            </div>
            <div className="classification-row">
              <label><span className="field-label">平台<span className="field-requirement required">必填</span></span><input value="Android" readOnly /></label>
              <label><span className="field-label">来源模块<span className="field-requirement optional">选填</span></span><input value="MissionGo" readOnly /></label>
              <label><span className="field-label">优先级<span className="field-requirement optional">选填</span></span><select value={priority} onChange={(event) => setPriority(event.target.value as WorkItemPriority)}>{PRIORITIES.map((value) => <option key={value} value={value}>{PRIORITY_LABELS[value]}</option>)}</select></label>
            </div>
            <label><span className="field-label">需要关注什么？<span className="field-requirement required">必填</span></span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={500} placeholder="用一句清晰、具体的话描述问题" required autoFocus /></label>
            <section className="attachment-picker-block capture-attachment-block">
              <div className="capture-attachment-heading">
                <div className="capture-attachment-copy"><strong><span className="field-label">图片与视频<span className="field-requirement optional">选填</span></span></strong><p>添加截图或录屏可以更快说明问题，最多 10 个附件。</p></div>
                <label className="secondary-button sdk-feedback-picker"><ImageIcon size={16} /> 添加<input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,image/heic,video/mp4,video/quicktime,video/webm" onChange={selectFiles("media")} /></label>
              </div>
              {selectedMedia.length > 0 && <div className="sdk-feedback-selected">{selectedMedia.map(({ id, file }) => <span key={id}><ImageIcon size={14} /><strong>{file.name}</strong></span>)}</div>}
            </section>
            <section className="report-input-block">
              <header><strong>问题说明</strong><small>请说明实际现象、发生条件、期望结果和影响范围。</small></header>
              <label><span className="field-label">实际发生了什么？<span className="field-requirement required">必填</span></span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={20_000} rows={6} placeholder="实际发生了什么？如何复现？期望结果是什么？" required /></label>
            </section>
            <section className="diagnostic-input-block">
              <div className="diagnostic-input-heading">
                <span><strong>诊断信息</strong><small>仅包含宿主 App 主动提供的日志，不读取 Android 系统日志。</small></span>
                <label className="secondary-button sdk-feedback-picker"><Paperclip size={16} /> 上传日志<input type="file" multiple accept=".log,.txt,.json,text/plain,application/json" onChange={selectFiles("log")} /></label>
              </div>
              {selectedLogs.length > 0 && <div className="sdk-feedback-selected">{selectedLogs.map(({ id, file }) => <span key={id}><FileText size={14} /><strong>{file.name}</strong></span>)}</div>}
              {draft.logs.length > 0 && <label className="sdk-feedback-check"><input type="checkbox" checked={includeLogs} onChange={(event) => setIncludeLogs(event.target.checked)} /><span>附带宿主主动提供的最近 {draft.logs.length} 条诊断日志</span></label>}
              {draft.logs.length === 0 && <p className="sdk-feedback-empty-log">当前没有宿主主动提供的诊断日志。</p>}
            </section>
            <details className="capture-optional">
              <summary><ChevronRight size={16} /><span><strong>自动附带的信息</strong><small>App 版本、Android 版本、设备型号和反馈入口等排查信息</small></span></summary>
              <div className="capture-optional-body"><dl className="sdk-feedback-context">{contextEntries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></div>
            </details>
            <p className="privacy-note">只提交本页展示及你主动选择的内容，不读取账号、剪贴板、其他应用或完整系统日志。</p>
            <div className="form-footer sdk-feedback-actions">
              <button className="secondary-button" type="submit" disabled={submitting || !title.trim()}>{submitting && destination === "inbox" ? <LoaderCircle className="spin" size={17} /> : <FileText size={17} />}{submitting && destination === "inbox" ? "正在保存…" : "保存到草稿"}</button>
              <button className="primary-button" type="button" disabled={submitting || !title.trim() || !description.trim()} onClick={() => void submit("ready")}>{submitting && destination === "ready" ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{submitting && destination === "ready" ? "正在提交…" : "提交到待处理"}</button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
