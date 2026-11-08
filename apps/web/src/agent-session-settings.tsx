import { useAgentOperationFeedback } from "./agent-operation-feedback";
import { modeChoices, modeReasonKey } from "./agent-mode-options";
import { Select } from "./select";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, MoreHorizontal } from "lucide-react";

import { normalizeAgentMode, type AgentKind, type AgentModeCapability } from "@missiongo/domain";

import { api, ApiError } from "./api";
import { errorMessageKey, localizedErrorText } from "./error-text";
import { useOverlay } from "./overlay";
import { agentModels, effortLabelKey, effortOptions, groupModelsByProvider, modelDisplayLabel, reconcileEffort } from "./agent-model-options";
import { dispatchModeLabelKey } from "./dispatch-eligibility";
import { useI18n } from "./i18n";
import type { AgentSessionSummary, FreeSessionConfig, NodeAgentModel } from "./types";

/**
 * Mode, model and effort of one conversation, under the reply box (AND-158).
 * The model select keeps the person's choice separate from the model id the
 * Mac reports (a Claude alias can resolve to a different id). A pick applies immediately: these are one-click,
 * one-click-back changes, so the only confirmation is the pending note that
 * appears while the Mac has not answered (AND-130's revision handshake).
 */
export function AgentSessionQuickSettings({ session }: { session: AgentSessionSummary }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const settings = session.settings;
  const sessionId = session.agentSessionId ?? session.id;
  const [dismissedSettingsErrors, setDismissedSettingsErrors] = useState<Readonly<Record<string, string>>>({});
  const lastRequestedModel = useRef(new Map<string, string>());
  const applying = useRef(new Set<string>());
  const [pendingSessions, setPendingSessions] = useState<ReadonlySet<string>>(new Set());
  const settingsIdentity = JSON.stringify([settings.pending, settings.mode, settings.model, settings.effort, settings.error]);
  const feedback = useAgentOperationFeedback({ sessionId,
    checkedAt: queryClient.getQueryState(["agent-sessions"])?.dataUpdatedAt ?? 0, settingsIdentity });
  const external = session.source === "external";
  const nodeId = session.nodeId ?? session.nativeConnection?.nodeId;
  const replyPending = external && ["queued", "delivering", "delivery_unknown"].includes(session.command?.status ?? "");
  const canChange = (field: "mode" | "model" | "effort") => settings.adjustable
    && (!external || !replyPending && Boolean(session.canReply) && Boolean(settings.supportedFields?.includes(field)));
  const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes, enabled: Boolean(nodeId) });
  const modeCapabilities=nodesQuery.data?.nodes.find(node=>node.id===nodeId)?.agents.find(agent=>agent.kind===session.agentKind)?.modes;
  const models = session.agentKind === "other" ? undefined : agentModels(nodesQuery.data?.nodes.find((node) => node.id === nodeId), session.agentKind);

  const apply = useMutation({
    mutationFn: (input: { sessionId: string; change: { mode?: string; model?: string; effort?: string }; settingsIdentity: string }) =>
      api.setAgentSessionSettings(input.sessionId, input.change),
    onMutate: input => feedback.begin(input.sessionId, "settings", { id: input.settingsIdentity }),
    onError: (error, _input, operation) => feedback.fail(error, operation),
    onSettled: (_data, _error, input) => {
      applying.current.delete(input.sessionId);
      setPendingSessions(current => { const next = new Set(current); next.delete(input.sessionId); return next; });
    },
    onSuccess: async (_settings, input, operation) => {
      feedback.finish(operation);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-sessions"] }),
        queryClient.invalidateQueries({ queryKey: ["agent-session", input.sessionId] }),
      ]);
    },
  });

  const failure = feedback.failures.find(candidate => candidate.sessionId === sessionId && candidate.target.id === settingsIdentity && !candidate.superseded);
  const applyError = failure?.error;
  const sourceError = settings.error && dismissedSettingsErrors[sessionId] !== settingsIdentity
    ? <div className="agent-operation-feedback agent-session-settings-note error" role="alert"><span>{t("agentSettingsError", { error: settings.error })}</span>
      <button type="button" className="secondary-button" onClick={() => setDismissedSettingsErrors(current => ({ ...current, [sessionId]: settingsIdentity }))}>{t("close")}</button>
    </div> : null;
  const modeLabel = (value: string) => {
    const key = dispatchModeLabelKey(session.agentKind, value);
    return key ? t(key) : value === "external" ? t("agentSettingsSourceMode") : value;
  };
  const effortLabel = (value: string) => {
    const key = effortLabelKey(value);
    return key ? t(key) : value;
  };
  const endpointNote = settings.modelEndpoint ? ` · ${t("customModelEndpoint", { host: settings.modelEndpoint })}` : "";
  const requestedModel = settings.pending?.model ?? settings.requestedModel ?? (external ? settings.model : undefined) ?? "";
  // A refused change leaves the request in the server's history. Show the
  // Mac's previous value in the picker so the person can choose that code
  // again; the error explains why the requested change was refused.
  const modelValue = settings.error && !settings.pending ? settings.model ?? "" : requestedModel;
  const modelLabel = (id: string | undefined) => {
    const entry = models?.find((option) => option.id === id);
    return entry ? modelDisplayLabel(entry, models ?? []) : id || t("dispatchModelLocal");
  };
  const selectedModelLabel = modelLabel(modelValue);
  const shownEffort = settings.pending?.effort ? effortLabel(settings.pending.effort) : settings.effort
    ? effortLabel(settings.effort)
    : settings.requestedEffort
      ? `${effortLabel(settings.requestedEffort)}（${t("agentSettingsRequested")}）`
      : t("dispatchModelLocal");
  const pendingText = settings.pending
    ? [
        settings.pending.mode ? modeLabel(settings.pending.mode) : null,
        settings.pending.model ? modelLabel(settings.pending.model) : null,
        settings.pending.effort ? effortLabel(settings.pending.effort) : null,
      ].filter(Boolean).join(" · ")
    : "";

  // While a pick waits for the Mac, the select shows the picked value -- that is
  // what the person last said -- and the pending note below says it is not in
  // effect yet. If the Mac refuses it, the note turns into the error and the
  // selects fall back to what is confirmed.
  const modeValue = settings.pending?.mode ?? settings.mode;
  const effortValue = settings.pending?.effort ?? settings.effort ?? "";

  if ((!settings.adjustable || !session.agentSessionId) && !external) {
    return (
      <div className="agent-session-quick-settings">
        <p className="agent-session-quick-settings-summary">
          {modeLabel(settings.mode)} · {shownEffort}
        </p>
        <p className="agent-session-settings-note" title={selectedModelLabel}>{modelLabel(settings.model ?? settings.requestedModel)}{endpointNote}</p>
        {settings.pending && <p className="agent-session-settings-note" role="status">{t(external && settings.applyOn === "next_reply" ? "agentSettingsNextReply" : "agentSettingsPending", { change: pendingText })}</p>}
        {sourceError}
      </div>
    );
  }

  return (
    <div className="agent-session-quick-settings">
      <AgentSettingsControls agentKind={session.agentKind} modes={modeCapabilities} models={models} mode={modeValue} model={modelValue}
        effort={effortValue} effortDisplay={shownEffort} external={external} busy={pendingSessions.has(sessionId)} canChange={canChange}
        onChange={change => {
          if (applying.current.has(sessionId) || !session.agentSessionId) return;
          applying.current.add(sessionId);
          lastRequestedModel.current.set(sessionId, change.model ?? modelValue);
          setPendingSessions(current => new Set(current).add(sessionId));
          setDismissedSettingsErrors(current => { const next = { ...current }; delete next[sessionId]; return next; });
          apply.mutate({ sessionId: session.agentSessionId, change, settingsIdentity });
        }} />
      {settings.requiresImplementationMode && <p className="agent-session-settings-note" role="status">{t("agentImplementationModeRequired")}</p>}
      {external && <p className="agent-session-settings-note">{t(!session.canReply && !settings.unavailableReason
        ? "agentSettingsExternalUnavailable"
        : settings.unavailableReason === "connect" ? "agentSettingsExternalConnect"
        : settings.unavailableReason === "upgrade" ? "agentSettingsExternalUpgrade"
        : settings.unavailableReason === "source" ? "agentSettingsExternalSource"
        : "agentSettingsExternalSupported")}</p>}
      {external && settings.adjustable && !settings.supportedFields?.includes("mode") && <p className="agent-session-settings-note">{t("agentSettingsExternalMode")}</p>}
      {endpointNote && <p className="agent-session-settings-note">{t("customModelEndpoint", { host: settings.modelEndpoint! })}</p>}
      {settings.pending && <p className="agent-session-settings-note" role="status">{t(external && settings.applyOn === "next_reply" ? "agentSettingsNextReply" : "agentSettingsPending", { change: pendingText })}</p>}
      {sourceError}
      {failure && (
        <div className="agent-operation-feedback agent-session-settings-note error" role="alert">
          <span>{applyError instanceof ApiError && applyError.code === "node_upgrade_required"
            ? t("agentSettingsUpgrade")
            : applyError instanceof ApiError && applyError.code === "agent_effort_unavailable"
            ? t("agentSettingsEffortConflict", { model: modelLabel(lastRequestedModel.current.get(sessionId) ?? modelValue) })
            : errorMessageKey(applyError) ? localizedErrorText(applyError, t)
            : t("agentSettingsApplyFailed")}</span>
          <button type="button" className="secondary-button" onClick={() => feedback.finish(failure)}>{t("close")}</button>
          {!errorMessageKey(applyError) && applyError instanceof Error && <details className="agent-operation-diagnostic"><summary>{t("executionStopDiagnostic")}</summary><p>{applyError.message}</p></details>}
        </div>
      )}
    </div>
  );
}

/** Shared reply-bar controls. Local drafts never call the session settings API. */
export function AgentSettingsControls({ agentKind, modes, models, mode: modeValue, model: modelValue, effort: effortValue,
  external = false, busy = false, allowLocalDefaults = false, effortDisplay, canChange, onChange }: {
  modes?: readonly AgentModeCapability[] | undefined;
  agentKind: AgentKind | "other"; models: readonly NodeAgentModel[] | undefined;
  mode: string; model: string; effort: string; external?: boolean; busy?: boolean; allowLocalDefaults?: boolean; effortDisplay?: string;
  canChange: (field: "mode" | "model" | "effort") => boolean;
  onChange: (change: { mode?: string; model?: string; effort?: string }) => void;
}) {
  const { t } = useI18n();
  const [moreOpen, setMoreOpen] = useState(false);
  const [showEffortNote, setShowEffortNote] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const morePanelRef = useRef<HTMLDivElement>(null);
  const closeMore = () => setMoreOpen(false);
  const openMore = () => setMoreOpen(true);
  useOverlay(moreOpen, () => { closeMore(); moreRef.current?.focus({ preventScroll: true }); }, { ref: morePanelRef, close: closeMore });
  useEffect(() => {
    if (!showEffortNote) return;
    const timer = window.setTimeout(() => setShowEffortNote(false), 5000);
    return () => window.clearTimeout(timer);
  }, [showEffortNote]);
  const modeLabel = (value: string) => {
    const key = dispatchModeLabelKey(agentKind, value);
    return key ? t(key) : value === "external" ? t("agentSettingsSourceMode") : value;
  };
  const effortLabel = (value: string) => {
    const key = effortLabelKey(value);
    return key ? t(key) : value;
  };
  const modelLabel = (value: string) => {
    const entry = models?.find(model => model.id === value);
    return entry ? modelDisplayLabel(entry, models ?? []) : value || t("dispatchModelLocal");
  };
  const selectedModelLabel = modelLabel(modelValue);
  const shownEffort = effortDisplay ?? (effortValue ? effortLabel(effortValue) : t("dispatchModelLocal"));
  const availableEfforts = external && !models?.some(entry => entry.id === modelValue) ? [] : effortOptions(models, modelValue);
  const changeMode = (mode: string) => { if (mode !== modeValue) onChange({ mode }); closeMore(); };
  const changeEffort = (effort: string) => {
    if ((allowLocalDefaults || effort) && effort !== effortValue) {
      onChange({ effort });
      if (agentKind === "codex" && !allowLocalDefaults) setShowEffortNote(true);
    }
    closeMore();
  };
  const modeOptions = <>
    {external && <option value={normalizeAgentMode(agentKind,modeValue)}>{modeLabel(modeValue)}</option>}
    {!modeValue && <option value="" disabled>{t("dispatchModeChoose")}</option>}
    {(agentKind === "other" ? [] : modeChoices(agentKind,modeValue,modes,modelValue || undefined))
      .filter(choice=>!external || choice.value!==normalizeAgentMode(agentKind,modeValue)).map(choice=><option key={choice.value}
        value={choice.value} disabled={choice.state!=="available"}>{modeLabel(choice.value)}{choice.state!=="available" ? ` · ${t(modeReasonKey(choice))}` : ""}</option>)}
  </>;
  return <>
      <div className="agent-session-quick-settings-row">
        <Select
          className="agent-settings-mode"
          aria-label={t("dispatchMode")}
          value={normalizeAgentMode(agentKind,modeValue)}
          disabled={busy || !canChange("mode")}
          onChange={(event) => changeMode(event.target.value)}
        >
          {modeOptions}
        </Select>
        <Select
          className="agent-settings-model"
          aria-label={t("dispatchModel")}
          value={modelValue}
          title={selectedModelLabel}
          disabled={busy || !models || !canChange("model")}
          onChange={(event) => {
            const model = event.target.value;
            if ((allowLocalDefaults || model) && model !== modelValue) onChange({ model });
          }}
        >
          {/* Use the same catalog labels as dispatch, including pending picks. */}
          <option value={modelValue}>{selectedModelLabel}</option>
          {allowLocalDefaults && modelValue && <option value="">{t("dispatchModelLocal")}</option>}
          {groupModelsByProvider((models ?? []).filter((entry) => entry.id !== modelValue)).map((group) => (
            group.provider === null
              ? group.models.map((entry) => (
                <option key={entry.id} value={entry.id}>{modelDisplayLabel(entry, models ?? [])}</option>
              ))
              : (
                <optgroup key={group.provider} label={group.provider}>
                  {group.models.map((entry) => (
                  <option key={entry.id} value={entry.id}>{modelDisplayLabel(entry, models ?? [])}</option>
                  ))}
                </optgroup>
              )
          ))}
        </Select>
        <Select
          className="agent-settings-effort"
          aria-label={t("dispatchEffort")}
          value={effortValue}
          disabled={busy || !models || !canChange("effort") || availableEfforts.length === 0}
          onChange={(event) => changeEffort(event.target.value)}
        >
          {allowLocalDefaults && effortValue && <option value="">{t("dispatchModelLocal")}</option>}
          {effortValue && <option value={effortValue}>{shownEffort}</option>}
          {!effortValue && <option value="">{shownEffort}</option>}
          {availableEfforts.filter((value) => value !== effortValue).map((value) => (
            <option key={value} value={value}>{effortLabel(value)}</option>
          ))}
        </Select>
        <div className="agent-settings-more" ref={morePanelRef}>
          <button ref={moreRef} type="button" className="secondary-button" aria-label={t("moreActions")} aria-expanded={moreOpen} onClick={() => (moreOpen ? closeMore() : openMore())}><MoreHorizontal size={18} /></button>
          {moreOpen && <div className="agent-settings-more-panel">
            <label>{t("dispatchMode")}
              <Select value={normalizeAgentMode(agentKind,modeValue)} disabled={busy || !canChange("mode")} onChange={(event) => changeMode(event.target.value)}>
                {modeOptions}
              </Select>
            </label>
            <label>{t("dispatchEffort")}
              <Select value={effortValue} disabled={busy || !models || !canChange("effort") || availableEfforts.length === 0} onChange={(event) => changeEffort(event.target.value)}>
                {allowLocalDefaults && effortValue && <option value="">{t("dispatchModelLocal")}</option>}
                {effortValue && <option value={effortValue}>{shownEffort}</option>}
                {!effortValue && <option value="">{shownEffort}</option>}
                {availableEfforts.filter((value) => value !== effortValue).map((value) => <option key={value} value={value}>{effortLabel(value)}</option>)}
              </Select>
            </label>
          </div>}
        </div>
        {busy && <LoaderCircle className="spin" size={13} aria-hidden="true" />}
      </div>
    {showEffortNote && <p className="agent-session-settings-note" role="status">{t("agentSettingsCodexEffortNote")}</p>}
  </>;
}

export function DraftSessionQuickSettings({ config, disabled, onChange }: {
  config: FreeSessionConfig; disabled: boolean; onChange: (config: FreeSessionConfig) => void;
}) {
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes });
  const models = agentModels(nodes.data?.nodes.find(node => node.id === config.nodeId), config.agentKind);
  return <div className="agent-session-quick-settings">
    <AgentSettingsControls agentKind={config.agentKind} modes={nodes.data?.nodes.find(node=>node.id===config.nodeId)?.agents.find(agent=>agent.kind===config.agentKind)?.modes} models={models} mode={config.mode}
      allowLocalDefaults model={config.model ?? ""} effort={config.effort ?? ""} canChange={() => !disabled}
      onChange={change => {
        if (change.mode !== undefined) { onChange({ ...config, mode: change.mode }); return; }
        const { model: _model, effort: _effort, ...base } = config;
        onChange({ ...base, ...("mode" in change ? { mode: change.mode! } : {}),
          ...reconcileEffort(models, { ...(config.model ? { model: config.model } : {}), ...(config.effort ? { effort: config.effort } : {}), ...change }) });
      }} />
  </div>;
}
