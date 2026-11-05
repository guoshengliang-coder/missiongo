import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ArrowRight, ChevronDown, ChevronUp } from "lucide-react";
import { api } from "./api";
import {
  collaborationApi as collab,
  type Draft,
  type Grant,
  type CollaborationDetail,
} from "./collaboration-api";
import { Modal } from "./modal";
import { Select } from "./select";
import { OverlayMenu } from "./overlay";
import { RecordDisclosure } from "./record-disclosure";
import { useI18n } from "./i18n";
import { localizedErrorText } from "./error-text";
import { clearDraftFiles, loadDraftFiles, saveDraftFiles } from "./draft-files";
import {
  EMPTY_CAPTURE_DRAFT,
  hasCaptureDraftContent,
  parseCaptureDraft,
  workItemReportPayload,
  type CaptureDraft,
} from "./capture-draft";
import { WorkItemFields, environmentDraft, environmentPayload, filesWithDiagnosticLog } from "./work-item-form";
import { platformName } from "./environment-summary";
import { validateIncomingFiles } from "./incoming-files";
import { useFileDropZone } from "./file-drop";
import { FileDropOverlay } from "./file-drop-overlay";
import { MAX_DIAGNOSTIC_LOG_BYTES, diagnosticLogBytes } from "./diagnostics";
import type { Product, WorkItem } from "./types";
import "./collaboration.css";

/** Keep a command ID across network retries, but never across changed intent. */
function useCommandKey() {
  const keys = useRef(new Map<string, string>());
  return (body: unknown) => {
    const intent = JSON.stringify(body);
    let key = keys.current.get(intent);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(intent, key);
    }
    return key;
  };
}
function useOperation() {
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const { t } = useI18n();
  return {
    pending,
    error,
    run: async (fn: () => Promise<void>) => {
      if (pending) return;
      setPending(true);
      setError("");
      try {
        await fn();
      } catch (e) {
        setError(localizedErrorText(e, t));
      } finally {
        setPending(false);
      }
    },
  };
}
function Failure({ error }: { error: string }) {
  return error ? (
    <p className="inline-error" role="alert">
      {error}
    </p>
  ) : null;
}

export function CollaborationPanel({
  item,
  requestedAction,
  onActionHandled,
  onOpenItem,
}: {
  item: WorkItem;
  requestedAction?: "request" | "associate" | undefined;
  onActionHandled?: () => void;
  onOpenItem?: (itemKey: string) => void;
}) {
  const { t, statusLabel } = useI18n(),
    client = useQueryClient();
  const [draft, setDraft] = useState<Draft | null | undefined>(undefined),
    [selected, setSelected] = useState<string | null>(null),
    [associate, setAssociate] = useState(false),
    [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const addMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!addMenu.current?.contains(event.target as Node))
        addMenu.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const q = useQuery({
    queryKey: ["collaboration", item.key],
    queryFn: () => collab.context(item.key),
    refetchInterval: 15000,
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["collaboration"] }),
      client.invalidateQueries({ queryKey: ["items"] }),
      client.invalidateQueries({ queryKey: ["item", item.key] }),
      client.invalidateQueries({ queryKey: ["timeline", item.key] }),
      client.invalidateQueries({ queryKey: ["personal-notifications"] }),
    ]);
  };
  const close = () => {
    setDraft(undefined);
    setAssociate(false);
    onActionHandled?.();
  };
  const showRequest = requestedAction === "request" || draft !== undefined,
    showAssociate = requestedAction === "associate" || associate;
  const data = q.data;
  const count = data?.requests.length ?? 0;
  const draftCount = data?.drafts.length ?? 0;
  // AND-406: the target item may exist while its new files failed to upload.
  // Retrying only uploads; the request is never submitted twice.
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(() => readPendingUpload(item.key));
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingError, setPendingError] = useState("");
  useEffect(() => {
    setPendingUpload(readPendingUpload(item.key));
  }, [item.key, data]);
  const discardPending = async () => {
    if (!pendingUpload) return;
    writePendingUpload(item.key, null);
    localStorage.removeItem(`missiongo.collaboration-draft.v1.${item.key}`);
    await clearDraftFiles(collaborationDraftKey(item.key));
    setPendingUpload(null);
    setPendingError("");
  };
  const retryPending = async () => {
    if (!pendingUpload) return;
    setPendingBusy(true);
    setPendingError("");
    try {
      const failed = await retryCollaborationUploads(item.key, pendingUpload);
      if (failed > 0) {
        setPendingError(t("collaborationUploadFailed", { key: pendingUpload.targetKey, count: failed }));
      } else {
        setPendingUpload(null);
        await refresh();
      }
    } finally {
      setPendingBusy(false);
    }
  };
  const hasContent = count + draftCount > 0 || Boolean(pendingUpload);
  const selectedDirection = selected
    ? data?.requests.find((r) => r.id === selected)?.direction
    : undefined;
  return (
    <section
      className="collaboration-panel"
      aria-label={t("collaborationRelations")}
      aria-busy={q.isPending}
    >
      <div className="collaboration-heading">
        <div className="collaboration-heading-label">
          <h3>{t("collaborationRelations")}{count > 0 && `（${count}）`}</h3>
          {draftCount > 0 && <span className="collaboration-draft-count">{t("collaborationReviewCount", { count: draftCount })}</span>}
        </div>
        <div className="collaboration-heading-actions">
          {data?.canRequest && <OverlayMenu
            ref={addMenu}
            className="detail-more-menu collaboration-add-menu"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
            }}
            onToggle={(event) => {
              const menu = event.currentTarget;
              if (!menu.open) return;
              const box = menu.getBoundingClientRect();
              const area = menu.closest(".detail-scroll")?.getBoundingClientRect();
              const below = Math.min(innerHeight, area?.bottom ?? innerHeight) - box.bottom;
              const above = box.top - Math.max(0, area?.top ?? 0);
              const popover = menu.querySelector(".detail-more-menu-popover");
              const height = popover?.scrollHeight ?? 0;
              const openAbove = below < height + 7 && above > below;
              menu.dataset.side = openAbove ? "above" : "below";
              menu.style.setProperty("--collaboration-menu-height", `${Math.max(44, (openAbove ? above : below) - 7)}px`);
              menu.dataset.align = "end";
              if ((popover?.getBoundingClientRect().left ?? 0) < Math.max(8, area?.left ?? 0)) menu.dataset.align = "start";
            }}
          >
            <summary className="text-button"><Plus size={16} aria-hidden="true" />{t("collaborationAddDependency")}</summary>
            <div className="detail-more-menu-popover">
              <button type="button" onClick={() => { addMenu.current?.removeAttribute("open"); setDraft(null); }}>{t("collaborationRequest")}</button>
              <button type="button" onClick={() => { addMenu.current?.removeAttribute("open"); setAssociate(true); }}>{t("collaborationAssociate")}</button>
            </div>
          </OverlayMenu>}
          {hasContent && <button
            className="text-button collaboration-toggle"
            type="button"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded(!expanded)}
          >
            {t(expanded ? "collaborationCollapse" : "collaborationExpand")}
            {expanded ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
          </button>}
        </div>
      </div>
      {data?.blocked && <p className="collaboration-warning" role="status">{t("collaborationBlocked")}</p>}
      {q.isPending && <p role="status">{t("settingsLoading")}</p>}
      {q.isError && (
        <div role="alert">
          <p>{t("collaborationReadError")}</p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void q.refetch()}
          >
            {t("retry")}
          </button>
        </div>
      )}
      {data && (
        <div id={bodyId} className="collaboration-body" hidden={!hasContent || !expanded}>
          {(["outgoing", "incoming"] as const).map((direction) => {
            const rows = data.requests.filter(
              (r) => r.direction === direction,
            );
            return (
              rows.length > 0 && (
                <div className="collaboration-group" key={direction}>
                  <h4>
                    {t(
                      direction === "outgoing"
                        ? "collaborationWaiting"
                        : "collaborationWaited",
                    )}
                  </h4>
                  {rows.map((r) => (
                    <RecordDisclosure className="execution-record collaboration-record" key={r.id}
                      summary={r.restricted ? <strong>{t("collaborationRestrictedTitle")}</strong> : <>
                        <strong>{direction === "outgoing" ? `${r.targetKey} · ${r.targetProductName}` : `${r.sourceKey} · ${r.sourceProductName}`}</strong>
                        <span>{r.targetTitle}</span>
                        <small>{r.builderName} · {t("collaborationVerifier")}：{r.verifierName}</small>
                      </>}
                      status={!r.restricted && <span className={`status-pill collaboration-status status-${r.status}`}>{statusLabel(r.status)}</span>}
                    >
                    <div className="execution-record-body collaboration-record-body">
                      {r.restricted ? (
                        <>
                          <p>{t("collaborationRestricted")}</p>
                          {r.canManageAccess && (
                            <RestoreAccess id={r.id} onSaved={refresh} />
                          )}{" "}
                          {r.canWithdraw && r.blocking && (
                            <RestoreAccess
                              id={r.id}
                              revision={r.revision}
                              withdraw
                              onSaved={refresh}
                            />
                          )}
                        </>
                      ) : (
                        <>
                          <p className="collaboration-prose">{r.targetTitle}</p>
                          <button
                            className="text-button"
                            type="button"
                            aria-label={`${t("collaborationDetail")} · ${direction === "outgoing" ? r.targetKey : r.sourceKey}`}
                            onClick={() => setSelected(r.id)}
                          >
                            {t("collaborationDetail")}
                            <ArrowRight size={16} />
                          </button>
                          {r.withdrawn && <p>{t("collaborationWithdrawn")}</p>}
                        </>
                      )}
                    </div>
                    </RecordDisclosure>
                  ))}
                </div>
              )
            );
          })}
          {pendingUpload && (
            <div className="collaboration-group">
              <h4>{t("collaborationPendingUploads", { key: pendingUpload.targetKey })}</h4>
              <div className="collaboration-card">
                <p>{t("collaborationPendingUploadsHelp")}</p>
                <div className="collaboration-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={pendingBusy}
                    onClick={() => void retryPending()}
                  >
                    {t("collaborationRetryUploads")}
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    disabled={pendingBusy}
                    onClick={() => void discardPending()}
                  >
                    {t("collaborationDiscardUploads")}
                  </button>
                </div>
                {pendingError && <Failure error={pendingError} />}
              </div>
            </div>
          )}
          {data.drafts.length > 0 && (
            <div className="collaboration-group">
              <h4>{t("collaborationDrafts")}</h4>
              {data.drafts.map((d) => (
                <div className="collaboration-card" key={d.id}>
                  <strong>{d.title}</strong>
                  <span> · v{d.version}</span>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={!data.canRequest}
                    onClick={() => setDraft(d)}
                  >
                    {t("collaborationReview")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {showRequest && (
        <CollaborationRequest
          item={item}
          initial={draft ?? null}
          onClose={close}
          onSaved={async () => {
            close();
            await refresh();
          }}
        />
      )}
      {showAssociate && (
        <AssociateDialog
          item={item}
          onClose={close}
          onSaved={async () => {
            close();
            await refresh();
          }}
        />
      )}
      {selected && (
        <SharedCollaboration
          id={selected}
          {...(selectedDirection ? { direction: selectedDirection } : {})}
          onClose={() => setSelected(null)}
          onChanged={refresh}
          {...(onOpenItem ? { onOpenItem } : {})}
        />
      )}
    </section>
  );
}
function RestoreAccess({
  id,
  onSaved,
  withdraw = false,
  revision,
}: {
  id: string;
  onSaved: () => Promise<void>;
  withdraw?: boolean;
  revision?: number;
}) {
  const { t } = useI18n(),
    [open, setOpen] = useState(false),
    [note, setNote] = useState(""),
    op = useOperation(),
    key = useCommandKey();
  return (
    <>
      <button
        type="button"
        className="secondary-button"
        onClick={() => setOpen(true)}
      >
        {t(withdraw ? "collaborationWithdraw" : "collaborationRestore")}
      </button>
      {open && (
        <Modal
          title={t(withdraw ? "collaborationWithdraw" : "collaborationRestore")}
          subtitle=""
          onClose={() => setOpen(false)}
          dirty={!!note}
          pending={op.pending}
        >
          <form
            className="collaboration-form"
            onSubmit={(e) => {
              e.preventDefault();
              void op.run(async () => {
                await collab.command(
                  id,
                  withdraw ? "withdraw" : "restore-access",
                  { note, revision, idempotencyKey: key({ note, revision }) },
                );
                setOpen(false);
                await onSaved();
              });
            }}
          >
            <label>
              {t("collaborationNote")}
              <textarea
                required
                disabled={op.pending}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
              />
            </label>
            <Failure error={op.error} />
            <button
              className="primary-button"
              disabled={op.pending || !note.trim()}
            >
              {t("collaborationConfirm")}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
const COLLABORATION_FILE_LIMIT = 10;

/** Files the request created but could not upload yet. */
interface PendingUpload {
  requestId: string;
  targetKey: string;
  diagnosticLog: string;
  /** How many files the request was submitted with; guards a lost device copy. */
  fileCount: number;
}
function collaborationDraftKey(itemKey: string) {
  return `collaboration:${itemKey}`;
}
function pendingStorageKey(itemKey: string) {
  return `missiongo.collaboration-pending.v1.${itemKey}`;
}
function readPendingUpload(itemKey: string): PendingUpload | null {
  try {
    const raw = localStorage.getItem(pendingStorageKey(itemKey));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingUpload>;
    return typeof value.requestId === "string" && typeof value.targetKey === "string"
      && typeof value.diagnosticLog === "string"
      ? {
          requestId: value.requestId,
          targetKey: value.targetKey,
          diagnosticLog: value.diagnosticLog,
          fileCount: typeof value.fileCount === "number" ? value.fileCount : 0,
        }
      : null;
  } catch {
    return null;
  }
}
function writePendingUpload(itemKey: string, value: PendingUpload | null) {
  if (value) localStorage.setItem(pendingStorageKey(itemKey), JSON.stringify(value));
  else localStorage.removeItem(pendingStorageKey(itemKey));
}
async function uploadRequestFiles(pending: PendingUpload, files: readonly File[]) {
  const all = filesWithDiagnosticLog(files, pending.diagnosticLog);
  // A retry on another device can find the draft text but not the files.
  let failed = Math.max(0, pending.fileCount - all.length);
  for (const [index, file] of all.entries()) {
    try {
      // Stable per target item and position: a retry after a reload resolves to
      // the same attachment instead of creating a duplicate.
      await api.uploadAttachment(
        pending.targetKey,
        file,
        `request-${pending.targetKey}-${index}-${file.lastModified}`,
      );
    } catch {
      failed += 1;
    }
  }
  return failed;
}
export async function retryCollaborationUploads(itemKey: string, pending: PendingUpload) {
  const files = await loadDraftFiles(collaborationDraftKey(itemKey));
  const failed = await uploadRequestFiles(pending, files);
  if (failed === 0) {
    writePendingUpload(itemKey, null);
    localStorage.removeItem(`missiongo.collaboration-draft.v1.${itemKey}`);
    await clearDraftFiles(collaborationDraftKey(itemKey));
  }
  return failed;
}
export { readPendingUpload };

/** A prepared draft reopens with the same report, environment and type. */
function draftFromServer(initial: Draft): CaptureDraft {
  return {
    ...EMPTY_CAPTURE_DRAFT,
    title: initial.title,
    description: initial.description,
    reproductionSteps: initial.report?.reproductionSteps ?? "",
    expectedOutcome: initial.report?.expectedOutcome ?? "",
    impact: initial.report?.impact ?? "",
    occurrenceFrequency: initial.report?.occurrenceFrequency ?? "unknown",
    type: initial.type,
    priority: initial.priority,
    environment: environmentDraft(initial.environment),
  };
}

function CollaborationRequest({
  item,
  initial,
  onClose,
  onSaved,
}: {
  item: WorkItem;
  initial: Draft | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t, typeLabel, priorityLabel } = useI18n(),
    op = useOperation(),
    key = useCommandKey();
  const targets = useQuery({
    queryKey: ["collaboration-targets", item.key],
    queryFn: () => collab.targets(item.key),
  });
  const storageKey = `missiongo.collaboration-draft.v1.${item.key}`,
    filesKey = collaborationDraftKey(item.key);
  const restored = (() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return { grantId: "", acceptance: "", draft: undefined };
      const value = JSON.parse(raw) as { grantId?: unknown; acceptance?: unknown; draft?: unknown };
      return {
        grantId: typeof value.grantId === "string" ? value.grantId : "",
        acceptance: typeof value.acceptance === "string" ? value.acceptance : "",
        draft: value.draft && typeof value.draft === "object" ? JSON.stringify(value.draft) : undefined,
      };
    } catch {
      return { grantId: "", acceptance: "", draft: undefined };
    }
  })();
  const [draft, setDraft] = useState<CaptureDraft>(() =>
    initial ? draftFromServer(initial) : parseCaptureDraft(restored.draft ?? null));
  const [grantId, setGrantId] = useState(initial?.grantId ?? restored.grantId);
  const [acceptance, setAcceptance] = useState(initial?.acceptance ?? restored.acceptance);
  const [files, setFiles] = useState<readonly File[]>([]);
  const [filesReady, setFilesReady] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [savedDraft, setSavedDraft] = useState<Draft | null>(initial);
  const [preview, setPreview] = useState(Boolean(initial));
  const [approved, setApproved] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(() => readPendingUpload(item.key));
  const [uploadError, setUploadError] = useState("");

  // Restore the draft and its files once per item; a grant change does not
  // throw away what the person already wrote or selected.
  useEffect(() => {
    let active = true;
    void loadDraftFiles(filesKey)
      .catch(() => [])
      .then((restoredFiles) => {
        if (active) setFiles((current) => current.length > 0 ? current : restoredFiles);
      })
      .finally(() => {
        if (active) setFilesReady(true);
      });
    return () => { active = false; };
  }, [filesKey]);
  useEffect(() => {
    if (!filesReady) return undefined;
    void saveDraftFiles(filesKey, files);
    return undefined;
  }, [files, filesReady, filesKey]);
  useEffect(() => {
    const hasContent = hasCaptureDraftContent(draft) || Boolean(grantId) || Boolean(acceptance.trim());
    if (hasContent) localStorage.setItem(storageKey, JSON.stringify({ grantId, acceptance, draft }));
    else localStorage.removeItem(storageKey);
  }, [acceptance, draft, grantId, storageKey]);

  const logBytes = diagnosticLogBytes(draft.diagnosticLog);
  const totalFiles = files.length + (draft.diagnosticLog.trim() ? 1 : 0);
  const addIncomingFiles = (incoming: readonly File[]) => {
    const diagnosticSlots = draft.diagnosticLog.trim() ? 1 : 0;
    const result = validateIncomingFiles(files, incoming, t, COLLABORATION_FILE_LIMIT - diagnosticSlots);
    setFiles(result.files);
    setFileError(result.error ?? null);
  };
  const remainingSlots = Math.max(0, COLLABORATION_FILE_LIMIT - (draft.diagnosticLog.trim() ? 1 : 0) - files.length);
  const { isDraggingFiles, dropHandlers } = useFileDropZone(addIncomingFiles, { canAccept: remainingSlots > 0 });
  const target = targets.data?.targets.find((g) => g.id === grantId);
  const dirty = !pendingUpload && Boolean(
    hasCaptureDraftContent(draft) || grantId || acceptance.trim() || files.length > 0 || preview,
  );

  const clearLocalDraft = async () => {
    localStorage.removeItem(storageKey);
    await clearDraftFiles(filesKey);
  };
  const finishUploads = async (pending: PendingUpload) => {
    setUploadError("");
    const failed = await uploadRequestFiles(pending, files);
    if (failed > 0) {
      setUploadError(t("collaborationUploadFailed", { key: pending.targetKey, count: failed }));
      return;
    }
    writePendingUpload(item.key, null);
    setPendingUpload(null);
    await clearLocalDraft();
    await onSaved();
  };

  return (
    <Modal
      title={t(preview ? "collaborationApproval" : "collaborationRequest")}
      subtitle={item.key}
      onClose={onClose}
      dirty={dirty}
      pending={op.pending}
      wide
      scrolls
    >
      {(requestClose) => (
        <form
          className="collaboration-form"
          onSubmit={(e) => {
            e.preventDefault();
            void op.run(async () => {
              if (pendingUpload) {
                await finishUploads(pendingUpload);
                return;
              }
              if (preview) {
                if (!approved || !savedDraft) return;
                const result = await collab.submit(savedDraft, key({ id: savedDraft.id, version: savedDraft.version }));
                const pending = {
                  requestId: result.id,
                  targetKey: result.targetKey,
                  diagnosticLog: draft.diagnosticLog,
                  fileCount: filesWithDiagnosticLog(files, draft.diagnosticLog).length,
                };
                setPendingUpload(pending);
                writePendingUpload(item.key, pending);
                await finishUploads(pending);
              } else {
                const body = {
                  grantId,
                  title: draft.title,
                  description: draft.description,
                  acceptance,
                  type: draft.type,
                  priority: draft.priority,
                  report: workItemReportPayload(draft),
                  environment: environmentPayload(draft.environment, undefined, true),
                  attachmentIds: [],
                };
                const d = await collab.prepare(item.key, {
                  ...body,
                  idempotencyKey: key({ form: body, id: savedDraft?.id, version: savedDraft?.version }),
                  ...(savedDraft ? { draftId: savedDraft.id, expectedVersion: savedDraft.version } : {}),
                });
                setSavedDraft(d);
                setPreview(true);
                setApproved(false);
              }
            });
          }}
          onPaste={(event) => {
            const pasted = Array.from(event.clipboardData.files);
            if (pasted.length > 0 && !preview) {
              event.preventDefault();
              addIncomingFiles(pasted);
            }
          }}
          {...(preview ? {} : dropHandlers)}
        >
          <fieldset disabled={op.pending}>
            {pendingUpload ? (
              <div className="collaboration-pending">
                <h3>{t("collaborationPendingTitle", { key: pendingUpload.targetKey })}</h3>
                <p>{t("collaborationPendingUploadsHelp")}</p>
                {uploadError && <Failure error={uploadError} />}
              </div>
            ) : preview ? (
              <>
                <p>
                  {target
                    ? `${target.targetName} · ${target.moduleName ?? t("collaborationAllModules")}`
                    : t("collaborationTarget")}
                </p>
                <h3>{draft.title}</h3>
                <p>
                  {typeLabel(draft.type)} · {priorityLabel(draft.priority)}
                  {draft.environment.platform && ` · ${platformName(draft.environment.platform, t)}`}
                </p>
                <p className="collaboration-prose">{draft.description}</p>
                {draft.type === "bug" && (draft.reproductionSteps.trim() || draft.expectedOutcome.trim() || draft.impact.trim()) && (
                  <>
                    <h4>{t("bugOptionalDetails")}</h4>
                    {draft.reproductionSteps.trim() && <p className="collaboration-prose">{draft.reproductionSteps}</p>}
                    {draft.expectedOutcome.trim() && <p className="collaboration-prose">{draft.expectedOutcome}</p>}
                    {draft.impact.trim() && <p className="collaboration-prose">{draft.impact}</p>}
                  </>
                )}
                <h4>{t("collaborationAcceptance")}</h4>
                <p className="collaboration-prose">{acceptance}</p>
                <h4>{t("collaborationNewFiles")}</h4>
                <ul>
                  {filesWithDiagnosticLog(files, draft.diagnosticLog).map((file) => (
                    <li key={`${file.name}-${file.size}-${file.lastModified}`}>{file.name}</li>
                  ))}
                </ul>
                <p className="collaboration-warning">
                  {t("collaborationApprovalHelp")}
                </p>
                <label className="collaboration-check">
                  <input
                    type="checkbox"
                    checked={approved}
                    onChange={(e) => setApproved(e.target.checked)}
                  />
                  {t("collaborationConsent")}
                </label>
              </>
            ) : (
              <>
                <label>
                  {t("collaborationTarget")}
                  <Select
                    value={grantId}
                    onChange={(e) => setGrantId(e.target.value)}
                    required
                  >
                    <option value="">{t("collaborationChoose")}</option>
                    {targets.data?.targets.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.targetName} ·{" "}
                        {g.moduleName ?? t("collaborationAllModules")}
                      </option>
                    ))}
                  </Select>
                </label>
                {targets.isError && (
                  <Failure error={t("collaborationReadError")} />
                )}
                {isDraggingFiles && <FileDropOverlay remaining={remainingSlots} />}
                <WorkItemFields
                  productId={item.productId}
                  titleProductId={item.productId}
                  showComponentField={false}
                  types={["bug", "requirement"]}
                  draft={draft}
                  onDraft={setDraft}
                  files={files}
                  onFiles={setFiles}
                  fileError={fileError}
                  attachmentLimit={COLLABORATION_FILE_LIMIT}
                />
                <label>
                  {t("collaborationAcceptance")}
                  <textarea
                    required
                    rows={3}
                    maxLength={10000}
                    value={acceptance}
                    onChange={(e) => {
                      setAcceptance(e.target.value);
                      setApproved(false);
                    }}
                  />
                </label>
                <p className="dispatch-note">{t("collaborationDraftHelp")}</p>
              </>
            )}
          </fieldset>
          <Failure error={op.error} />
          <div className="form-footer">
            <button
              type="button"
              className="secondary-button"
              disabled={op.pending}
              onClick={requestClose}
            >
              {t("cancel")}
            </button>
            {preview && !pendingUpload && (
              <button
                type="button"
                className="secondary-button"
                disabled={op.pending}
                onClick={() => {
                  setPreview(false);
                  setApproved(false);
                }}
              >
                {t("edit")}
              </button>
            )}
            <button
              className="primary-button"
              type="submit"
              disabled={
                op.pending ||
                (pendingUpload
                  ? false
                  : preview
                    ? (!approved || !target)
                    : (!grantId ||
                      !draft.title.trim() ||
                      !draft.description.trim() ||
                      !acceptance.trim() ||
                      logBytes > MAX_DIAGNOSTIC_LOG_BYTES ||
                      totalFiles > COLLABORATION_FILE_LIMIT))
              }
            >
              {t(
                op.pending
                  ? "collaborationProgress"
                  : pendingUpload
                    ? "collaborationRetryUploads"
                    : preview
                      ? "collaborationApprove"
                      : "collaborationPreview",
              )}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
function AssociateDialog({
  item,
  onClose,
  onSaved,
}: {
  item: WorkItem;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n(),
    op = useOperation(),
    key = useCommandKey(),
    [targetKey, setTargetKey] = useState(""),
    [grantId, setGrant] = useState(""),
    [note, setNote] = useState("");
  const targets = useQuery({
    queryKey: ["collaboration-targets", item.key],
    queryFn: () => collab.targets(item.key),
  });
  return (
    <Modal
      title={t("collaborationAssociate")}
      subtitle={item.key}
      onClose={onClose}
      dirty={!!targetKey || !!note || !!grantId}
      pending={op.pending}
    >
      {(requestClose) => (
        <form
          className="collaboration-form"
          onSubmit={(e) => {
            e.preventDefault();
            void op.run(async () => {
              const body = { targetKey, grantId, note };
              await collab.associate(item.key, {
                ...body,
                idempotencyKey: key(body),
              });
              await onSaved();
            });
          }}
        >
          <fieldset disabled={op.pending}>
            <p>{t("collaborationExistingHelp")}</p>
            <label>
              {t("collaborationTarget")}
              <Select
                required
                value={grantId}
                onChange={(e) => setGrant(e.target.value)}
              >
                <option value="">{t("collaborationChoose")}</option>
                {targets.data?.targets.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.targetName} ·{" "}
                    {g.moduleName ?? t("collaborationAllModules")}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              {t("collaborationExistingKey")}
              <input
                required
                value={targetKey}
                onChange={(e) => setTargetKey(e.target.value)}
                maxLength={50}
              />
            </label>
            <label>
              {t("collaborationNote")}
              <textarea
                required
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
              />
            </label>
          </fieldset>
          <Failure error={op.error} />
          <div className="form-footer">
            <button
              type="button"
              className="secondary-button"
              disabled={op.pending}
              onClick={requestClose}
            >
              {t("cancel")}
            </button>
            <button
              className="primary-button"
              disabled={op.pending || !grantId}
            >
              {t("collaborationConfirm")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function SharedCollaboration({
  id,
  direction,
  onClose,
  onChanged,
  onOpenItem,
}: {
  id: string;
  direction?: "outgoing" | "incoming";
  onClose: () => void;
  onChanged: () => Promise<void>;
  onOpenItem?: (itemKey: string) => void;
}) {
  const { t, statusLabel } = useI18n(),
    q = useQuery({
      queryKey: ["collaboration-detail", id],
      queryFn: () => collab.detail(id),
      refetchInterval: 15000,
    });
  const [action, setAction] = useState<
    | "verify"
    | "discussion"
    | "withdraw"
    | "verifier"
    | "rebind"
    | "revoke"
    | null
  >(null);
  const refresh = async () => {
    setAction(null);
    await q.refetch();
    await onChanged();
  };
  const d = q.isError ? undefined : q.data;
  const [actionSnapshot, setActionSnapshot] = useState<CollaborationDetail>();
  const openAction = (next: NonNullable<typeof action>) => {
    setActionSnapshot(d);
    setAction(next);
  };
  return (
    <Modal
      title={t(
        action === "verify" ? "collaborationVerify" : "collaborationDetail",
      )}
      subtitle={d ? `${d.targetKey} · ${d.targetProductName}` : ""}
      onClose={onClose}
      wide
      scrolls
    >
      {(requestClose) =>
        q.isPending ? (
          <p role="status">{t("settingsLoading")}</p>
        ) : !d ? (
          <div>
            <Failure error={t("collaborationReadError")} />
            <button
              className="secondary-button"
              type="button"
              onClick={() => void q.refetch()}
            >
              {t("retry")}
            </button>
          </div>
        ) : action ? (
          <CollaborationAction
            detail={actionSnapshot ?? d}
            action={action}
            onCancel={requestClose}
            onSaved={refresh}
          />
        ) : (
          <div className="collaboration-shared">
            <p className="dispatch-note">{t("collaborationSharedHelp")}</p>
            <h3>{d.targetTitle}</h3>
            <span className={`status-badge status-${d.status}`}>
              {statusLabel(d.status)}
            </span>
            <p>
              {d.builderName} · {t("collaborationVerifier")}：{d.verifierName}
            </p>
            <p className="collaboration-prose">{d.request.description}</p>
            <h4>{t("collaborationAcceptance")}</h4>
            <p className="collaboration-prose">{d.request.acceptance}</p>
            <ul>
              {d.request.attachments.map((f) => (
                <li key={f.id}>
                  <a href={collab.attachment(id, f.id)} download>
                    {f.filename}
                  </a>
                </li>
              ))}
            </ul>
            <p
              className={d.blocking ? "collaboration-warning" : "dispatch-note"}
            >
              {t(d.blocking ? "collaborationBlocked" : "collaborationEnded")}
            </p>
            <h4>{t("collaborationDiscussion")}</h4>
            {d.events
              .filter((e) => e.payload.note)
              .map((e) => (
                <div className="collaboration-card" key={e.id}>
                  <small>
                    {e.actorName}
                    {e.actorKind === "agent" ? " · Agent" : ""} ·{" "}
                    {new Date(e.createdAt).toLocaleString()}
                  </small>
                  <p className="collaboration-prose">{e.payload.note}</p>
                </div>
              ))}
            <div className="form-footer collaboration-actions">
              {direction === "incoming" && onOpenItem && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    const key = d.sourceKey;
                    onClose();
                    requestAnimationFrame(() => onOpenItem(key));
                  }}
                >
                  {t("collaborationOpenSource")}
                </button>
              )}
              {d.canDiscuss && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => openAction("discussion")}
                >
                  {t("collaborationSend")}
                </button>
              )}
              {d.canWithdraw && !d.withdrawn && (
                <>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => openAction("withdraw")}
                  >
                    {t("collaborationWithdraw")}
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => openAction("rebind")}
                  >
                    {t("collaborationRebind")}
                  </button>
                </>
              )}
              {d.canTransferVerifier && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => openAction("verifier")}
                >
                  {t("collaborationTransfer")}
                </button>
              )}
              {d.canManageAccess && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => openAction("revoke")}
                >
                  {t("collaborationRevoke")}
                </button>
              )}
              {d.canVerify && (
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => openAction("verify")}
                >
                  {t("collaborationVerify")}
                </button>
              )}
            </div>
          </div>
        )
      }
    </Modal>
  );
}
function CollaborationAction({
  detail: d,
  action,
  onCancel,
  onSaved,
}: {
  detail: CollaborationDetail;
  action:
    | "verify"
    | "discussion"
    | "withdraw"
    | "verifier"
    | "rebind"
    | "revoke";
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n(),
    op = useOperation(),
    key = useCommandKey(),
    [note, setNote] = useState(""),
    [other, setOther] = useState(""),
    [consent, setConsent] = useState(false),
    [delivery, setDelivery] = useState(false);
  const candidates = useQuery({
    queryKey: ["collaboration-candidates", d.id],
    queryFn: () => collab.candidates(d.id),
    enabled: action === "verifier",
  });
  const send = (passed?: boolean) =>
    void op.run(async () => {
      const body = {
        note,
        revision: d.revision,
        targetRevision: d.targetRevision,
        ...(action === "verify" ? { passed } : {}),
        ...(action === "verifier" ? { successorId: other } : {}),
        ...(action === "rebind" ? { targetKey: other } : {}),
        ...(action === "discussion" ? { delivery } : {}),
      };
      await collab.command(d.id, action, {
        ...body,
        idempotencyKey: key(body),
      });
      await onSaved();
    });
  return (
    <ActionForm
      dirty={!!note || !!other || consent || delivery}
      pending={op.pending}
    >
      <form
        className="collaboration-form"
        onSubmit={(e) => {
          e.preventDefault();
          send(action === "verify" ? true : undefined);
        }}
      >
        <fieldset disabled={op.pending}>
          {action === "verify" && (
            <>
              <p>{t("collaborationVerifyHelp")}</p>
              <p className="collaboration-prose">{d.request.acceptance}</p>
              {d.events
                .filter((e) => e.kind === "delivery")
                .map((e) => (
                  <p className="collaboration-prose" key={e.id}>
                    {e.payload.note}
                  </p>
                ))}
            </>
          )}
          {action === "withdraw" && <p>{t("collaborationWithdrawHelp")}</p>}
          {action === "verifier" && (
            <label>
              {t("collaborationSuccessor")}
              <Select
                required
                value={other}
                onChange={(e) => setOther(e.target.value)}
              >
                <option value="">{t("collaborationChoose")}</option>
                {candidates.data?.people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              {candidates.isError && (
                <Failure error={t("collaborationReadError")} />
              )}
            </label>
          )}
          {action === "rebind" && (
            <label>
              {t("collaborationExistingKey")}
              <input
                required
                value={other}
                onChange={(e) => setOther(e.target.value)}
                maxLength={100}
              />
            </label>
          )}
          {action === "revoke" && <p>{t("collaborationRevokeHelp")}</p>}
          <label>
            {t("collaborationNote")}
            <textarea
              required
              maxLength={2000}
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {action === "verify" && (
            <label className="collaboration-check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              {t("collaborationVerifyConsent")}
            </label>
          )}
          {action === "discussion" && d.canDeliver && (
            <label className="collaboration-check">
              <input
                type="checkbox"
                checked={delivery}
                onChange={(e) => setDelivery(e.target.checked)}
              />
              {t("collaborationDelivery")}
            </label>
          )}
        </fieldset>
        <Failure error={op.error} />
        <div className="form-footer">
          <button
            className="secondary-button"
            type="button"
            disabled={op.pending}
            onClick={onCancel}
          >
            {t("cancel")}
          </button>
          {action === "verify" && (
            <button
              className="secondary-button"
              type="button"
              disabled={op.pending || !note.trim()}
              onClick={() => send(false)}
            >
              {t("collaborationFail")}
            </button>
          )}
          <button
            className="primary-button"
            disabled={
              op.pending || !note.trim() || (action === "verify" && !consent)
            }
          >
            {t(
              action === "verify"
                ? "collaborationPass"
                : "collaborationConfirm",
            )}
          </button>
        </div>
      </form>
    </ActionForm>
  );
}
import { useDialogDraft } from "./dialog-state";
import type { ReactNode } from "react";
function ActionForm({
  dirty,
  pending,
  children,
}: {
  dirty: boolean;
  pending: boolean;
  children: ReactNode;
}) {
  useDialogDraft(dirty, pending);
  return children;
}

export function CollaborationSettings({
  product,
  products,
  canManage,
}: {
  product: Product;
  products: readonly Product[];
  canManage: boolean;
}) {
  const { t } = useI18n(),
    [direction, setDirection] = useState("incoming"),
    [editing, setEditing] = useState<Grant | null | undefined>(undefined);
  const q = useQuery({
    queryKey: ["collaboration-grants", product.id],
    queryFn: () => collab.grants(product.id),
  });
  const rows =
    q.data?.grants.filter((g) =>
      direction === "incoming"
        ? g.targetProductId === product.id
        : g.sourceProductId === product.id,
    ) ?? [];
  return (
    <section className="collaboration-settings">
      <div
        className="collaboration-tabs"
        role="group"
        aria-label={t("collaborationTitle")}
      >
        {(["incoming", "outgoing"] as const).map((v) => (
          <button
            className="secondary-button"
            aria-pressed={direction === v}
            type="button"
            key={v}
            onClick={() => setDirection(v)}
          >
            {t(
              v === "incoming"
                ? "collaborationIncoming"
                : "collaborationOutgoing",
            )}
          </button>
        ))}
      </div>
      <p>{t("collaborationGrantHelp")}</p>
      {direction === "incoming" && canManage && (
        <button
          className="primary-button"
          type="button"
          onClick={() => setEditing(null)}
        >
          <Plus size={16} />
          {t("collaborationAdd")}
        </button>
      )}
      {q.isError && (
        <div>
          <Failure error={t("collaborationReadError")} />
          <button
            className="secondary-button"
            type="button"
            onClick={() => void q.refetch()}
          >
            {t("retry")}
          </button>
        </div>
      )}
      {q.isPending && <p role="status">{t("settingsLoading")}</p>}
      {rows.map((g) => (
        <div className="collaboration-card" key={g.id}>
          <strong>
            {direction === "incoming" ? g.sourceName : g.targetName}
          </strong>
          <p>
            {g.moduleName ?? t("collaborationAllModules")} ·{" "}
            {t("collaborationEnabled")}：{g.enabled ? "✓" : "—"}
          </p>
          {direction === "incoming" && canManage && (
            <button
              className="secondary-button"
              type="button"
              onClick={() => setEditing(g)}
            >
              {t("edit")}
            </button>
          )}
        </div>
      ))}
      <p>{t("collaborationFallback")}</p>
      {editing !== undefined && (
        <GrantForm
          product={product}
          products={products}
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSaved={async () => {
            setEditing(undefined);
            await q.refetch();
          }}
        />
      )}
    </section>
  );
}
function GrantForm({
  product,
  products,
  initial,
  onClose,
  onSaved,
}: {
  product: Product;
  products: readonly Product[];
  initial: Grant | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n(),
    op = useOperation();
  const [form, setForm] = useState({
    sourceProductId: initial?.sourceProductId ?? "",
    moduleId: initial?.moduleId ?? "",
    builderAccountId: initial?.builderAccountId ?? "",
    enabled: initial?.enabled ?? true,
  });
  const directory = useQuery({
    queryKey: ["collaboration-directory", product.id],
    queryFn: () => collab.directory(product.id),
  });
  const modules = useQuery({
      queryKey: ["components", product.id],
      queryFn: () => api.listComponents(product.id),
    }),
    builders = useQuery({
      queryKey: ["builders", product.id],
      queryFn: () => api.listBuilders(product.id),
    });
  return (
    <Modal
      title={t("collaborationConfigure")}
      subtitle={product.name}
      onClose={onClose}
      dirty={
        JSON.stringify(form) !==
        JSON.stringify({
          sourceProductId: initial?.sourceProductId ?? "",
          moduleId: initial?.moduleId ?? "",
          builderAccountId: initial?.builderAccountId ?? "",
          enabled: initial?.enabled ?? true,
        })
      }
      pending={op.pending}
    >
      {(requestClose) => (
        <form
          className="collaboration-form"
          onSubmit={(e) => {
            e.preventDefault();
            void op.run(async () => {
              await collab.configure(product.id, {
                ...form,
                builderAccountId: form.builderAccountId || null,
                expectedRevision: initial?.revision ?? 0,
              });
              await onSaved();
            });
          }}
        >
          <fieldset disabled={op.pending}>
            <label>
              {t("collaborationProject")}
              <Select
                required
                disabled={!!initial}
                value={form.sourceProductId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, sourceProductId: e.target.value }))
                }
              >
                <option value="">{t("collaborationChoose")}</option>
                {(directory.data?.projects ?? products)
                  .filter((p) => p.id !== product.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                {initial &&
                  !(directory.data?.projects ?? products).some(
                    (p) => p.id === initial.sourceProductId,
                  ) && (
                    <option value={initial.sourceProductId}>
                      {initial.sourceName}
                    </option>
                  )}
              </Select>
            </label>
            <label>
              {t("collaborationModule")}
              <Select
                disabled={!!initial}
                value={form.moduleId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, moduleId: e.target.value }))
                }
              >
                <option value="">{t("collaborationAllModules")}</option>
                {modules.data?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              {t("collaborationBuilder")}
              <Select
                value={form.builderAccountId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, builderAccountId: e.target.value }))
                }
              >
                <option value="">{t("collaborationFallback")}</option>
                {builders.data?.builders.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="collaboration-check">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) =>
                  setForm((f) => ({ ...f, enabled: e.target.checked }))
                }
              />
              {t("collaborationEnabled")}
            </label>
          </fieldset>
          <Failure error={op.error} />
          <div className="form-footer">
            <button
              className="secondary-button"
              type="button"
              disabled={op.pending}
              onClick={requestClose}
            >
              {t("cancel")}
            </button>
            <button
              className="primary-button"
              disabled={op.pending || !form.sourceProductId}
            >
              {t("collaborationConfirm")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
