import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ArrowRight } from "lucide-react";
import { api } from "./api";
import {
  collaborationApi as collab,
  type Draft,
  type Grant,
  type CollaborationDetail,
} from "./collaboration-api";
import { Modal } from "./modal";
import { Select } from "./select";
import { useI18n } from "./i18n";
import { localizedErrorText } from "./error-text";
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
}: {
  item: WorkItem;
  requestedAction?: "request" | "associate" | undefined;
  onActionHandled?: () => void;
}) {
  const { t, statusLabel } = useI18n(),
    client = useQueryClient();
  const [draft, setDraft] = useState<Draft | null | undefined>(undefined),
    [selected, setSelected] = useState<string | null>(null),
    [associate, setAssociate] = useState(false);
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
  return (
    <section
      className="collaboration-panel"
      aria-label={t("collaborationRelations")}
    >
      <div className="collaboration-heading">
        <h3>{t("collaborationRelations")}</h3>
        {q.data?.canRequest && (
          <button
            className="text-button"
            type="button"
            onClick={() => setDraft(null)}
          >
            <Plus size={16} />
            {t("collaborationRequest")}
          </button>
        )}
      </div>
      {q.isPending ? (
        <p role="status">{t("settingsLoading")}</p>
      ) : q.isError ? (
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
      ) : (
        <>
          {q.data.blocked && (
            <p className="collaboration-warning" role="status">
              {t("collaborationBlocked")}
            </p>
          )}
          {!q.data.requests.length && !q.data.drafts.length && (
            <p className="section-empty">{t("collaborationEmpty")}</p>
          )}
          {(["outgoing", "incoming"] as const).map((direction) => {
            const rows = q.data.requests.filter(
              (r) => r.direction === direction,
            );
            return (
              rows.length > 0 && (
                <div key={direction}>
                  <p>
                    {t(
                      direction === "outgoing"
                        ? "collaborationWaiting"
                        : "collaborationWaited",
                    )}
                  </p>
                  {rows.map((r) => (
                    <div className="collaboration-card" key={r.id}>
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
                          <button
                            className="text-button"
                            type="button"
                            onClick={() => setSelected(r.id)}
                          >
                            {direction === "outgoing"
                              ? `${r.targetKey} · ${r.targetProductName}`
                              : `${r.sourceKey} · ${r.sourceProductName}`}
                            <ArrowRight size={16} />
                          </button>
                          <span className={`status-badge status-${r.status}`}>
                            {statusLabel(r.status)}
                          </span>
                          <p>{r.targetTitle}</p>
                          <small>
                            {r.builderName} · {t("collaborationVerifier")}：
                            {r.verifierName}
                          </small>
                          {r.withdrawn && <p>{t("collaborationWithdrawn")}</p>}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )
            );
          })}
          {q.data.drafts.length > 0 && (
            <div>
              <h4>{t("collaborationDrafts")}</h4>
              {q.data.drafts.map((d) => (
                <div className="collaboration-card" key={d.id}>
                  <strong>{d.title}</strong>
                  <span> · v{d.version}</span>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={!q.data.canRequest}
                    onClick={() => setDraft(d)}
                  >
                    {t("collaborationReview")}
                  </button>
                </div>
              ))}
            </div>
          )}
          {q.data.canRequest && (
            <button
              className="text-button"
              type="button"
              onClick={() => setAssociate(true)}
            >
              {t("collaborationAssociate")}
            </button>
          )}
        </>
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
          onClose={() => setSelected(null)}
          onChanged={refresh}
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
  const [form, setForm] = useState({
    grantId: initial?.grantId ?? "",
    title: initial?.title ?? "",
    description: initial?.description ?? "",
    acceptance: initial?.acceptance ?? "",
    attachmentIds: initial?.attachmentIds ?? [],
    type: initial?.type ?? "requirement",
    priority: initial?.priority ?? "normal",
  });
  const [saved, setSaved] = useState(initial),
    [preview, setPreview] = useState(Boolean(initial)),
    [approved, setApproved] = useState(false);
  const dirty =
    JSON.stringify(form) !==
    JSON.stringify({
      grantId: initial?.grantId ?? "",
      title: initial?.title ?? "",
      description: initial?.description ?? "",
      acceptance: initial?.acceptance ?? "",
      attachmentIds: initial?.attachmentIds ?? [],
      type: initial?.type ?? "requirement",
      priority: initial?.priority ?? "normal",
    });
  const update = (
    field: "grantId" | "title" | "description" | "acceptance",
    value: string,
  ) => {
    setForm((f) => ({ ...f, [field]: value }));
    setApproved(false);
  };
  const target = targets.data?.targets.find((g) => g.id === form.grantId);
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
              if (preview) {
                if (!approved || !saved) return;
                await collab.submit(
                  saved,
                  key({ id: saved.id, version: saved.version }),
                );
                await onSaved();
              } else {
                const d = await collab.prepare(item.key, {
                  ...form,
                  idempotencyKey: key({
                    form,
                    id: saved?.id,
                    version: saved?.version,
                  }),
                  ...(saved
                    ? { draftId: saved.id, expectedVersion: saved.version }
                    : {}),
                });
                setSaved(d);
                setPreview(true);
                setApproved(false);
              }
            });
          }}
        >
          <fieldset disabled={op.pending}>
            {preview ? (
              <>
                <p>
                  {target
                    ? `${target.targetName} · ${target.moduleName ?? t("collaborationAllModules")}`
                    : t("collaborationTarget")}
                </p>
                <h3>{form.title}</h3>
                <p>
                  {typeLabel(form.type)} · {priorityLabel(form.priority)}
                </p>
                <p className="collaboration-prose">{form.description}</p>
                <h4>{t("collaborationAcceptance")}</h4>
                <p className="collaboration-prose">{form.acceptance}</p>
                <h4>{t("collaborationScope")}</h4>
                <p>{t("collaborationDraftHelp")}</p>
                <ul>
                  {item.attachments
                    .filter((f) => form.attachmentIds.includes(f.id))
                    .map((f) => (
                      <li key={f.id}>{f.filename}</li>
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
                    value={form.grantId}
                    onChange={(e) => update("grantId", e.target.value)}
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
                <label>
                  {t("collaborationType")}
                  <Select
                    value={form.type}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        type: e.target.value as Draft["type"],
                      }))
                    }
                  >
                    {(["bug", "requirement"] as const).map((v) => (
                      <option key={v} value={v}>
                        {typeLabel(v)}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  {t("collaborationPriority")}
                  <Select
                    value={form.priority}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        priority: e.target.value as Draft["priority"],
                      }))
                    }
                  >
                    {(["urgent", "high", "normal", "low"] as const).map((v) => (
                      <option key={v} value={v}>
                        {priorityLabel(v)}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  {t("collaborationTitleField")}
                  <input
                    required
                    maxLength={300}
                    value={form.title}
                    onChange={(e) => update("title", e.target.value)}
                  />
                </label>
                <label>
                  {t("collaborationEvidence")}
                  <textarea
                    required
                    rows={4}
                    maxLength={20000}
                    value={form.description}
                    onChange={(e) => update("description", e.target.value)}
                  />
                </label>
                <label>
                  {t("collaborationAcceptance")}
                  <textarea
                    required
                    rows={3}
                    maxLength={10000}
                    value={form.acceptance}
                    onChange={(e) => update("acceptance", e.target.value)}
                  />
                </label>
                <p>{t("collaborationShare")}</p>
                {item.attachments.map((f) => (
                  <label className="collaboration-check" key={f.id}>
                    <input
                      type="checkbox"
                      checked={form.attachmentIds.includes(f.id)}
                      onChange={(e) =>
                        setForm((x) => ({
                          ...x,
                          attachmentIds: e.target.checked
                            ? [...x.attachmentIds, f.id]
                            : x.attachmentIds.filter((id) => id !== f.id),
                        }))
                      }
                    />
                    {f.filename}
                  </label>
                ))}
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
            {preview && (
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
                (preview && (!approved || !target)) ||
                (!preview &&
                  (!form.grantId ||
                    !form.title.trim() ||
                    !form.description.trim() ||
                    !form.acceptance.trim()))
              }
            >
              {t(
                op.pending
                  ? "collaborationProgress"
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
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
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
