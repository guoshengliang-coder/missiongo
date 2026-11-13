// Shared creation/edit form for a work item (AND-406).
//
// The capture sheet, the edit dialog and a collaboration request all render
// this same block: type, report details, attachments, diagnostics and
// environment. Keeping one implementation is what stops the collaboration
// request from drifting into a second, smaller form.
import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type Dispatch as ReactDispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Bug,
  Inbox,
  Camera,
  ChevronRight,
  CirclePause,
  FileText,
  Highlighter,
  Lightbulb,
  ListTodo,
  LoaderCircle,
  Paperclip,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { MAX_ITEM_ATTACHMENTS } from "@missiongo/domain";
import { api } from "./api";
import { AutoGrowTextarea } from "./auto-grow-textarea";
import { MediaLightbox } from "./media-lightbox";
import { ZoomableImage } from "./zoomable-image";
import { ImageAnnotator } from "./lazy-image-annotator";
import { Select } from "./select";
import { useI18n } from "./i18n";
import { localizedErrorText } from "./error-text";
import {
  collectWebContext,
  diagnosticLogBytes,
  diagnosticLogFile,
  MAX_DIAGNOSTIC_LOG_BYTES,
} from "./diagnostics";
import { isAnnotatableImage } from "./image-annotation";
import { validateAttachment } from "./attachment-validation";
import type { CaptureDraft, EnvironmentDraft } from "./capture-draft";
import {
  COMPONENT_KINDS,
  ITEM_PRIORITIES,
  ITEM_TYPES,
  type WorkItemAttachment,
  type WorkItemEnvironment,
  type WorkItemOccurrenceFrequency,
  type WorkItemPriority,
  type WorkItemType,
} from "./types";

export const TYPE_ICONS: Record<WorkItemType, typeof Inbox> = {
  idea: Lightbulb,
  requirement: Sparkles,
  bug: Bug,
  task: ListTodo,
  note: FileText,
};

export { ImageAnnotator };

export const REPORT_COPY = {
  idea: { title: "ideaDetails", help: "ideaDetailsHelp", overview: "ideaOverview", placeholder: "ideaOverviewPlaceholder" },
  requirement: { title: "requirementDetails", help: "requirementDetailsHelp", overview: "requirementOverview", placeholder: "requirementOverviewPlaceholder" },
  bug: { title: "bugDetails", help: "bugDetailsHelp", overview: "bugOverview", placeholder: "bugOverviewPlaceholder" },
  task: { title: "taskDetails", help: "taskDetailsHelp", overview: "taskOverview", placeholder: "taskOverviewPlaceholder" },
  note: { title: "noteDetails", help: "noteDetailsHelp", overview: "noteOverview", placeholder: "noteOverviewPlaceholder" },
} as const satisfies Record<WorkItemType, {
  readonly title: "ideaDetails" | "requirementDetails" | "bugDetails" | "taskDetails" | "noteDetails";
  readonly help: "ideaDetailsHelp" | "requirementDetailsHelp" | "bugDetailsHelp" | "taskDetailsHelp" | "noteDetailsHelp";
  readonly overview: "ideaOverview" | "requirementOverview" | "bugOverview" | "taskOverview" | "noteOverview";
  readonly placeholder: "ideaOverviewPlaceholder" | "requirementOverviewPlaceholder" | "bugOverviewPlaceholder" | "taskOverviewPlaceholder" | "noteOverviewPlaceholder";
}>;

// Only a .log is machine output. Everything else readable is material a
// person wrote or exported, and belongs beside the report rather than in
// the diagnostics panel.
const LOG_FILE_EXTENSIONS = new Set(["log"]);
const DOCUMENT_FILE_EXTENSIONS = new Set(["md", "txt", "csv", "json", "pdf", "html"]);
const VIDEO_FILE_EXTENSIONS = new Set(["mp4", "mov", "webm"]);

function fileExtension(file: File): string {
  return file.name.split(".").pop()?.toLowerCase() ?? "";
}

export function isDiagnosticFile(file: File): boolean {
  return LOG_FILE_EXTENSIONS.has(fileExtension(file));
}

export function isDocumentFile(file: File): boolean {
  return DOCUMENT_FILE_EXTENSIONS.has(fileExtension(file));
}

export function isArchiveFile(file: File): boolean {
  return fileExtension(file) === "zip";
}

/** Images and videos: the attachments that are shown rather than read. */
export function isMediaAttachment(attachment: WorkItemAttachment): boolean {
  return attachment.kind === "image" || attachment.kind === "video";
}

export function mediaKindForFile(file: File): "image" | "video" {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return file.type.startsWith("video/") || VIDEO_FILE_EXTENSIONS.has(extension) ? "video" : "image";
}

export function environmentDraft(environment?: WorkItemEnvironment): EnvironmentDraft {
  return {
    platform: environment?.platform ?? "",
    appVersion: environment?.appVersion ?? "",
    buildNumber: environment?.buildNumber ?? "",
    sourceRevision: environment?.sourceRevision ?? "",
    osVersion: environment?.osVersion ?? "",
    deviceModel: environment?.deviceModel ?? "",
  };
}

export function environmentPayload(
  draft: EnvironmentDraft,
  existingMetadata?: Readonly<Record<string, string>>,
  collectCurrentWeb = false,
): WorkItemEnvironment | undefined {
  const appVersion = draft.appVersion.trim();
  const buildNumber = draft.buildNumber.trim();
  const sourceRevision = draft.sourceRevision.trim();
  const osVersion = draft.osVersion.trim();
  const deviceModel = draft.deviceModel.trim();
  const metadata = draft.platform === "web" && collectCurrentWeb ? collectWebContext() : existingMetadata;
  if (!draft.platform) return undefined;
  return {
    platform: draft.platform,
    ...(appVersion ? { appVersion } : {}),
    ...(buildNumber ? { buildNumber } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(osVersion ? { osVersion } : {}),
    ...(deviceModel ? { deviceModel } : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function FieldLabel({ children, required = false }: { children: ReactNode; required?: boolean }) {
  const { t } = useI18n();
  return (
    <span className="field-label">
      {children}
      {required && <small className="field-requirement required">{t("requiredField")}</small>}
    </span>
  );
}

function hasOptionalEnvironmentDetails(draft: EnvironmentDraft): boolean {
  return Boolean(
    draft.appVersion.trim() ||
    draft.buildNumber.trim() ||
    draft.sourceRevision.trim() ||
    draft.osVersion.trim() ||
    draft.deviceModel.trim()
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function filesWithDiagnosticLog(files: readonly File[], log: string): readonly File[] {
  const generatedLog = diagnosticLogFile(log);
  return generatedLog ? [...files, generatedLog] : files;
}

export function mediaNumberLabel(kind: "image" | "video", displayNumber: number, t: ReturnType<typeof useI18n>["t"]): string {
  return t(kind === "image" ? "imageNumber" : "videoNumber", { number: displayNumber });
}

export function WorkItemFields({
  productId,
  titleProductId = productId,
  showComponentField = true,
  types = ITEM_TYPES,
  renderExistingAttachment,
  draft,
  onDraft,
  files,
  onFiles,
  fileError,
  attachmentLimit = MAX_ITEM_ATTACHMENTS,
  existingItemKey,
  existingAttachments = [],
}: {
  productId: string;
  /** The project whose operation permission covers the AI title action. */
  titleProductId?: string;
  /** Off when the caller cannot read the target project's modules (collaboration). */
  showComponentField?: boolean;
  /** Which report types this form offers; collaboration keeps bug/requirement. */
  types?: readonly WorkItemType[];
  renderExistingAttachment?: (attachment: WorkItemAttachment) => ReactNode;
  draft: CaptureDraft;
  onDraft: ReactDispatch<SetStateAction<CaptureDraft>>;
  files: readonly File[];
  onFiles: (files: readonly File[]) => void;
  fileError: string | null;
  attachmentLimit?: number;
  existingItemKey?: string;
  existingAttachments?: readonly WorkItemAttachment[];
}) {
  const { priorityLabel, t, typeLabel } = useI18n();
  const productsQuery = useQuery({ queryKey: ["products"], queryFn: () => api.listProducts() });
  const canOperate = productsQuery.data?.find(product => product.id === titleProductId)?.access?.canOperate === true;
  const componentsQuery = useQuery({ queryKey: ["components", productId], queryFn: () => api.listComponents(productId), enabled: showComponentField && Boolean(productId) });
  const logBytes = diagnosticLogBytes(draft.diagnosticLog);
  const diagnosticSlots = draft.diagnosticLog.trim() ? 1 : 0;
  const remainingAttachments = Math.max(0, attachmentLimit - files.length - diagnosticSlots);
  const attachmentOverflow = files.length + diagnosticSlots > attachmentLimit;
  const existingLogAttachments = existingAttachments.filter((attachment) => !attachment.commentId && !attachment.transitionEventId && attachment.kind === "log");
  const existingDocumentAttachments = existingAttachments.filter((attachment) => !attachment.commentId && !attachment.transitionEventId && attachment.kind === "document");
  const existingArchiveAttachments = existingAttachments.filter((attachment) => !attachment.commentId && !attachment.transitionEventId && attachment.kind === "archive");
  const existingMediaAttachments = existingAttachments.filter(attachment => !attachment.commentId && !attachment.transitionEventId && isMediaAttachment(attachment));
  const selectedLogFiles = files.filter(isDiagnosticFile);
  const selectedDocumentFiles = files.filter(isDocumentFile);
  const selectedArchiveFiles = files.filter(isArchiveFile);
  const selectedMediaFiles = files.filter((file) => !isDiagnosticFile(file) && !isDocumentFile(file) && !isArchiveFile(file));
  const withMediaFiles = (next: readonly File[]) => [...selectedLogFiles, ...selectedDocumentFiles, ...selectedArchiveFiles, ...next];
  const withDocumentFiles = (next: readonly File[]) => [...selectedLogFiles, ...next, ...selectedArchiveFiles, ...selectedMediaFiles];
  const withArchiveFiles = (next: readonly File[]) => [...selectedLogFiles, ...selectedDocumentFiles, ...next, ...selectedMediaFiles];
  const withLogFiles = (next: readonly File[]) => [...next, ...selectedDocumentFiles, ...selectedArchiveFiles, ...selectedMediaFiles];
  const reportCopy = REPORT_COPY[draft.type];
  const showsBugFields = draft.type === "bug";
  const platformRequired = draft.type === "bug" || draft.type === "task";
  // Pasting a log or stack trace is the exception, not the rule (AND-364): the
  // block starts folded and opens only when it already holds something, so a
  // first-time reporter gets a short form and editing never hides a log behind
  // a closed summary.
  const diagnosticsOpen = Boolean(draft.diagnosticLog.trim())
    || selectedLogFiles.length > 0
    || existingLogAttachments.length > 0;

  const updateDraft = <Key extends keyof CaptureDraft>(key: Key, value: CaptureDraft[Key]) => {
    onDraft({ ...draft, [key]: value });
  };
  const titleMutation = useMutation({
    mutationFn: () => {
      if (!canOperate) throw new Error(t("captureReadOnly"));
      return api.generateTitle(titleProductId, draft.description);
    },
    onSuccess: ({ title }) => onDraft((current) => ({ ...current, title })),
  });

  useEffect(() => {
    if (!showComponentField || !draft.sourceComponentId || !componentsQuery.data) return;
    const selectedModule = componentsQuery.data.find((component) => component.id === draft.sourceComponentId);
    if (!selectedModule || (draft.environment.platform && selectedModule.kind !== draft.environment.platform)) {
      updateDraft("sourceComponentId", "");
    }
  }, [componentsQuery.data, draft.environment.platform, draft.sourceComponentId, showComponentField]);

  return (
    <>
      <div className="capture-type-grid" aria-label={t("type")}>
        {types.map((value) => {
          const Icon = TYPE_ICONS[value];
          return (
            <button key={value} type="button" className={`capture-type ${draft.type === value ? "active" : ""} type-${value}`} onClick={() => updateDraft("type", value)}>
              <Icon size={16} /> {typeLabel(value)}
            </button>
          );
        })}
      </div>
      <div className="classification-row">
        <label><FieldLabel required={platformRequired}>{t("platform")}</FieldLabel>
          <Select
            value={draft.environment.platform}
            onChange={(event) => {
              const platform = event.target.value as EnvironmentDraft["platform"];
              const selectedModule = componentsQuery.data?.find((component) => component.id === draft.sourceComponentId);
              onDraft({
                ...draft,
                sourceComponentId: selectedModule && selectedModule.kind !== platform ? "" : draft.sourceComponentId,
                environment: { ...draft.environment, platform },
              });
            }}
            required={platformRequired}
          >
            <option value="">{t("selectPlatform")}</option>
            {COMPONENT_KINDS.map((kind) => <option key={kind} value={kind}>{t(kind)}</option>)}
          </Select>
        </label>
        {showComponentField && (
          <label><FieldLabel>{t("sourceComponent")}</FieldLabel>
            <Select
            value={draft.sourceComponentId}
            onChange={(event) => {
              const sourceComponentId = event.target.value;
              const kind = componentsQuery.data?.find((component) => component.id === sourceComponentId)?.kind;
              onDraft({
                ...draft,
                sourceComponentId,
                environment: kind
                  ? { ...draft.environment, platform: kind }
                  : draft.environment,
              });
            }}
            disabled={componentsQuery.isLoading || !draft.environment.platform}
          >
            <option value="">{t("allModules")}</option>
            {(componentsQuery.data ?? []).filter((component) => component.kind === draft.environment.platform).map((component) => <option key={component.id} value={component.id}>{component.name}</option>)}
          </Select>
          </label>
        )}
        <label><FieldLabel>{t("priority")}</FieldLabel><Select value={draft.priority} onChange={(event) => updateDraft("priority", event.target.value as WorkItemPriority)}>{ITEM_PRIORITIES.map((value) => <option key={value} value={value}>{priorityLabel(value)}</option>)}</Select></label>
      </div>
      <div className="ai-title-field">
        <label><FieldLabel required>{t("whatNeedsAttention")}</FieldLabel><input value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} placeholder={t("clearSpecificTitle")} required autoFocus data-initial-focus /></label>
        <button type="button" className="secondary-button" disabled={!canOperate || titleMutation.isPending || !draft.description.trim()}
          title={!canOperate ? t("captureReadOnly") : !draft.description.trim() ? t("aiTitleNeedsContent") : undefined}
          onClick={() => titleMutation.mutate()}>
          {titleMutation.isPending ? t("aiTitleGenerating") : t("aiTitleButton")}
        </button>
      </div>
      <small className="ai-title-privacy">{t("aiTitlePrivacy")}</small>
      {titleMutation.isError && <InlineError message={localizedErrorText(titleMutation.error, t)} />}
      <section className="attachment-picker-block capture-attachment-block">
        <div className="capture-attachment-heading">
          <div className="capture-attachment-copy"><strong><FieldLabel>{t("mediaAttachments")}</FieldLabel></strong><p>{t("mediaAttachmentsHelp")}</p></div>
          <FilePicker
            files={selectedMediaFiles}
            onFiles={(nextMediaFiles) => onFiles(withMediaFiles(nextMediaFiles))}
            remaining={remainingAttachments}
            showSelectedFiles={false}
            accept="image/png,image/jpeg,image/webp,image/gif,image/heic,video/mp4,video/quicktime,video/webm"
            allowedExtensions={["png", "jpg", "jpeg", "webp", "gif", "heic", "mp4", "mov", "webm"]}
            buttonLabel={t("add")}
            addIcon
          />
        </div>
        {existingItemKey && existingMediaAttachments.length > 0 && renderExistingAttachment && (
          <div className="attachment-grid compact-attachment-grid">{existingMediaAttachments.map((attachment) => (
            <Fragment key={attachment.id}>{renderExistingAttachment(attachment)}</Fragment>
          ))}</div>
        )}
        {selectedMediaFiles.length > 0 && (
          <SelectedFilePreviews
            files={selectedMediaFiles}
            onFiles={(nextMediaFiles) => onFiles(withMediaFiles(nextMediaFiles))}
            startingNumbers={{
              image: Math.max(0, ...existingAttachments.filter((attachment) => attachment.kind === "image").map((attachment) => attachment.displayNumber)),
              video: Math.max(0, ...existingAttachments.filter((attachment) => attachment.kind === "video").map((attachment) => attachment.displayNumber)),
            }}
          />
        )}
      </section>
      <section className="attachment-picker-block capture-attachment-block">
        <div className="capture-attachment-heading">
          <div className="capture-attachment-copy"><strong><FieldLabel>{t("documentAttachments")}</FieldLabel></strong><p>{t("documentAttachmentsHelp")}</p></div>
          <FilePicker
            files={selectedDocumentFiles}
            onFiles={(nextDocumentFiles) => onFiles(withDocumentFiles(nextDocumentFiles))}
            remaining={remainingAttachments}
            showCamera={false}
            showSelectedFiles
            accept=".md,.txt,.csv,.json,.pdf,.html,text/markdown,text/plain,text/csv,application/json,application/pdf,text/html"
            allowedExtensions={["md", "txt", "csv", "json", "pdf", "html"]}
            buttonLabel={t("add")}
            addIcon
          />
        </div>
        {existingItemKey && existingDocumentAttachments.length > 0 && renderExistingAttachment && (
          <div className="attachment-grid compact-attachment-grid">{existingDocumentAttachments.map((attachment) => (
            <Fragment key={attachment.id}>{renderExistingAttachment(attachment)}</Fragment>
          ))}</div>
        )}
      </section>
      <section className="attachment-picker-block capture-attachment-block">
        <div className="capture-attachment-heading">
          <div className="capture-attachment-copy"><strong><FieldLabel>{t("archiveAttachments")}</FieldLabel></strong><p>{t("archiveAttachmentsHelp")}</p></div>
          <FilePicker
            files={selectedArchiveFiles}
            onFiles={(nextArchiveFiles) => onFiles(withArchiveFiles(nextArchiveFiles))}
            remaining={remainingAttachments}
            showCamera={false}
            showSelectedFiles
            accept=".zip,application/zip,application/x-zip-compressed"
            allowedExtensions={["zip"]}
            buttonLabel={t("add")}
            addIcon
          />
        </div>
        {existingItemKey && existingArchiveAttachments.length > 0 && renderExistingAttachment && (
          <div className="attachment-grid compact-attachment-grid">{existingArchiveAttachments.map((attachment) => (
            <Fragment key={attachment.id}>{renderExistingAttachment(attachment)}</Fragment>
          ))}</div>
        )}
      </section>
      {attachmentOverflow && <InlineError message={t("tooManyFiles", { count: attachmentLimit })} />}
      {fileError && <InlineError message={fileError} />}
      <section className="report-input-block">
        <header><strong>{t(reportCopy.title)}</strong><small>{t(reportCopy.help)}</small></header>
        <label><FieldLabel required>{t(reportCopy.overview)}</FieldLabel><AutoGrowTextarea value={draft.description} onChange={(event) => updateDraft("description", event.target.value)} placeholder={t(reportCopy.placeholder)} rows={4} maxLength={20_000} required /></label>
        {showsBugFields && (
          <details className="bug-optional-details">
            <summary><ChevronRight size={16} /><span>{t("bugOptionalDetails")}</span></summary>
            <div className="report-field-grid">
            <label><FieldLabel>{t("reproductionSteps")}</FieldLabel><AutoGrowTextarea value={draft.reproductionSteps} onChange={(event) => updateDraft("reproductionSteps", event.target.value)} placeholder={t("reproductionStepsPlaceholder")} rows={5} maxLength={20_000} /></label>
            <label><FieldLabel>{t("expectedOutcome")}</FieldLabel><AutoGrowTextarea value={draft.expectedOutcome} onChange={(event) => updateDraft("expectedOutcome", event.target.value)} placeholder={t("expectedOutcomePlaceholder")} rows={5} maxLength={20_000} /></label>
            <label><FieldLabel>{t("impact")}</FieldLabel><AutoGrowTextarea value={draft.impact} onChange={(event) => updateDraft("impact", event.target.value)} placeholder={t("impactPlaceholder")} rows={3} maxLength={10_000} /></label>
            <label><FieldLabel>{t("occurrenceFrequency")}</FieldLabel>
              <Select value={draft.occurrenceFrequency} onChange={(event) => updateDraft("occurrenceFrequency", event.target.value as WorkItemOccurrenceFrequency)}>
                <option value="unknown">{t("frequencyUnknown")}</option>
                <option value="once">{t("frequencyOnce")}</option>
                <option value="intermittent">{t("frequencyIntermittent")}</option>
                <option value="frequent">{t("frequencyFrequent")}</option>
                <option value="always">{t("frequencyAlways")}</option>
              </Select>
            </label>
            </div>
          </details>
        )}
      </section>
      <details className="diagnostic-input-block" open={diagnosticsOpen}>
        <summary className="diagnostic-input-heading">
          <span className="diagnostic-input-title">
            <ChevronRight size={16} />
            <span><strong>{t("diagnostics")}</strong><small>{t("diagnosticsHelp")}</small></span>
          </span>
          <FilePicker
            files={selectedLogFiles}
            onFiles={(nextLogFiles) => onFiles(withLogFiles(nextLogFiles))}
            remaining={remainingAttachments}
            showCamera={false}
            accept=".log,text/plain"
            allowedExtensions={["log"]}
            buttonLabel={t("uploadLog")}
            addIcon
          />
        </summary>
        <label><FieldLabel>{t("diagnosticLog")}</FieldLabel>
          <textarea
            className="diagnostic-log-input"
            value={draft.diagnosticLog}
            onChange={(event) => updateDraft("diagnosticLog", event.target.value)}
            placeholder={t("diagnosticLogPlaceholder")}
            rows={5}
            spellCheck={false}
          />
        </label>
        <footer>
          <small className={logBytes > MAX_DIAGNOSTIC_LOG_BYTES ? "over-limit" : ""}>{t("pastedLogSize", { size: formatBytes(logBytes), limit: formatBytes(MAX_DIAGNOSTIC_LOG_BYTES) })}</small>
          {draft.diagnosticLog && <button type="button" className="text-button" onClick={() => updateDraft("diagnosticLog", "")}><X size={13} /> {t("clearLog")}</button>}
        </footer>
        {logBytes > MAX_DIAGNOSTIC_LOG_BYTES && <InlineError message={t("diagnosticTooLarge")} />}
        {existingItemKey && existingLogAttachments.length > 0 && renderExistingAttachment && (
          <div className="attachment-grid compact-attachment-grid">{existingLogAttachments.map((attachment) => (
            <Fragment key={attachment.id}>{renderExistingAttachment(attachment)}</Fragment>
          ))}</div>
        )}
      </details>
      {/* Folded by default (AND-364): the web context is attached on its own,
          so an opened block of empty version fields only took up space. It
          still opens when it holds manually filled details. */}
      <details className="capture-optional" open={hasOptionalEnvironmentDetails(draft.environment)}>
        <summary><ChevronRight size={16} /> <span><strong>{t("optionalDetails")}</strong><small>{t("optionalDetailsHelp")}</small></span></summary>
        <div className="capture-optional-body">
          <EnvironmentFields value={draft.environment} onChange={(value) => updateDraft("environment", value)} />
          {draft.environment.platform === "web" && <p className="auto-context-note">{t("autoWebContext")}</p>}
        </div>
      </details>
    </>
  );
}

function EnvironmentFields({ value, onChange }: { value: EnvironmentDraft; onChange: (value: EnvironmentDraft) => void }) {
  const { t } = useI18n();
  const update = (field: keyof EnvironmentDraft, nextValue: string) => onChange({ ...value, [field]: nextValue });
  return (
    <fieldset className="environment-fields">
      <legend>{t("environmentDetails")}</legend>
      <p>{t("environmentHelp")}</p>
      <div className="field-row">
        <label>{t("appVersion")}<input value={value.appVersion} onChange={(event) => update("appVersion", event.target.value)} placeholder={t("notAvailableYet")} maxLength={500} /></label>
        <label>{t("buildNumber")}<input value={value.buildNumber} onChange={(event) => update("buildNumber", event.target.value)} placeholder={t("notAvailableYet")} maxLength={500} /></label>
        <label>{t("osVersion")}<input value={value.osVersion} onChange={(event) => update("osVersion", event.target.value)} placeholder={t("notAvailableYet")} maxLength={500} /></label>
        <label>{t("deviceModel")}<input value={value.deviceModel} onChange={(event) => update("deviceModel", event.target.value)} placeholder={t("notAvailableYet")} maxLength={500} /></label>
        <label>{t("sourceRevision")}<input value={value.sourceRevision} onChange={(event) => update("sourceRevision", event.target.value)} placeholder={t("notAvailableYet")} maxLength={500} /></label>
      </div>
    </fieldset>
  );
}

function FilePicker({
  files = [],
  onFiles,
  remaining,
  disabled = false,
  showSelectedFiles = true,
  showCamera = true,
  accept = "image/png,image/jpeg,image/webp,image/gif,image/heic,video/mp4,video/quicktime,video/webm,.log,.md,.txt,.csv,.json,.pdf,.html,.zip",
  allowedExtensions,
  buttonLabel,
  addIcon = false,
}: {
  files?: readonly File[];
  onFiles: (files: readonly File[]) => void;
  remaining: number;
  disabled?: boolean;
  showSelectedFiles?: boolean;
  showCamera?: boolean;
  accept?: string;
  allowedExtensions?: readonly string[];
  buttonLabel?: string;
  addIcon?: boolean;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);

  const addFiles = (selected: FileList | null) => {
    if (!selected) return;
    const incoming = Array.from(selected);
    if (incoming.length > remaining) {
      setError(t("tooManyFiles", { count: remaining }));
      return;
    }
    const accepted: File[] = [];
    let nextError: string | null = null;
    for (const file of incoming) {
      const validation = validateAttachment(file, allowedExtensions);
      if (!validation.valid && validation.reason === "unsupported") {
        nextError ??= t("unsupportedFile", { filename: file.name });
        continue;
      }
      if (!validation.valid && validation.reason === "too-large") {
        nextError ??= t("fileTooLarge", { filename: file.name, size: validation.limitMiB });
        continue;
      }
      accepted.push(file);
    }
    setError(nextError);
    if (accepted.length > 0) onFiles(files.length > 0 ? [...files, ...accepted] : accepted);
  };

  return (
    <div className="file-picker">
      <div className="file-picker-actions">
        <label className={`secondary-button file-picker-button ${disabled || remaining < 1 ? "disabled" : ""}`}>
          {disabled ? <LoaderCircle className="spin" size={16} /> : addIcon ? <Plus size={16} /> : <Paperclip size={16} />}
          {buttonLabel ?? t("addAttachments")}
          <input
            type="file"
            multiple
            accept={accept}
            disabled={disabled || remaining < 1}
            onChange={(event) => {
              addFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
        </label>
        {showCamera && <label className={`secondary-button file-picker-button mobile-only ${disabled || remaining < 1 ? "disabled" : ""}`}>
          <Camera size={16} /> {t("takePhoto")}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            disabled={disabled || remaining < 1}
            onChange={(event) => {
              addFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
        </label>}
      </div>
      {showSelectedFiles && files.length > 0 && (
        <div className="selected-files">
          {files.map((file, index) => (
            <span key={`${file.name}-${file.lastModified}-${index}`}>
              <Paperclip size={12} /> {file.name} <small>{formatBytes(file.size)}</small>
              <button type="button" onClick={() => onFiles(files.filter((_, fileIndex) => fileIndex !== index))} aria-label={t("removeFile", { filename: file.name })}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
      {error && <InlineError message={error} />}
    </div>
  );
}

function SelectedFilePreviews({
  files,
  onFiles,
  startingNumbers = { image: 0, video: 0 },
}: {
  files: readonly File[];
  onFiles: (files: readonly File[]) => void;
  startingNumbers?: Readonly<Record<"image" | "video", number>>;
}) {
  const { t } = useI18n();
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [annotatingIndex, setAnnotatingIndex] = useState<number | null>(null);
  const previews = useMemo(() => {
    const nextNumber = { image: startingNumbers.image, video: startingNumbers.video };
    return files.map((file) => {
      const kind = mediaKindForFile(file);
      nextNumber[kind] += 1;
      return { file, kind, displayNumber: nextNumber[kind], url: URL.createObjectURL(file) };
    });
  }, [files, startingNumbers.image, startingNumbers.video]);

  useEffect(() => () => {
    for (const preview of previews) URL.revokeObjectURL(preview.url);
  }, [previews]);

  useEffect(() => {
    if (previewIndex !== null && previewIndex >= previews.length) setPreviewIndex(null);
  }, [previewIndex, previews.length]);

  const activePreview = previewIndex === null ? undefined : previews[previewIndex];
  return (
    <div className="selected-preview-section">
      <p>{t("selectedAttachments", { count: files.length })}</p>
      <div className="selected-preview-grid">
        {previews.map(({ file, url, kind, displayNumber }, index) => {
          const isImage = kind === "image";
          const isVideo = kind === "video";
          const referenceLabel = mediaNumberLabel(kind, displayNumber, t);
          return (
            <article className="selected-preview-card" key={`${file.name}-${file.size}-${file.lastModified}`}>
              <button type="button" className="selected-preview-media" onClick={() => setPreviewIndex(index)} aria-label={t("previewAttachment", { filename: file.name })}>
                <small className="media-number-badge">{referenceLabel}</small>
                {isImage && <img src={url} alt="" />}
                {isVideo && <video src={url} muted playsInline preload="metadata" />}
                <em>{t("preview")}</em>
              </button>
              <footer>
                <span><strong>{referenceLabel} · {file.name}</strong><small>{formatBytes(file.size)}</small></span>
                {isImage && isAnnotatableImage(file) && (
                  <button type="button" onClick={() => setAnnotatingIndex(index)} aria-label={t("annotateTitle")} title={t("annotate")}><Highlighter size={14} /></button>
                )}
                <button type="button" onClick={() => onFiles(files.filter((_, fileIndex) => fileIndex !== index))} aria-label={t("removeFile", { filename: file.name })}><X size={14} /></button>
              </footer>
            </article>
          );
        })}
      </div>
      {activePreview && (
        <MediaLightbox
          title={mediaNumberLabel(activePreview.kind, activePreview.displayNumber, t)}
          onClose={() => setPreviewIndex(null)}
        >
          {activePreview.kind === "image" && <ZoomableImage src={activePreview.url} alt={activePreview.file.name} />}
          {activePreview.kind === "video" && <video src={activePreview.url} controls playsInline preload="metadata" />}
        </MediaLightbox>
      )}
      {annotatingIndex !== null && files[annotatingIndex] && (
        <ImageAnnotator
          file={files[annotatingIndex]}
          onCancel={() => setAnnotatingIndex(null)}
          onSave={(annotated) => {
            onFiles(files.map((current, fileIndex) => fileIndex === annotatingIndex ? annotated : current));
            setAnnotatingIndex(null);
          }}
        />
      )}
    </div>
  );
}

export function InlineError({ message, role }: { message: string; role?: "alert" }) {
  return <div className="inline-error" role={role}><CirclePause size={16} /><span>{message}</span></div>;
}

