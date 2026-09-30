import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, MoreHorizontal } from "lucide-react";

import { DISPATCH_MODES_BY_AGENT } from "@missiongo/domain";

import { api, ApiError } from "./api";
import { reportAndroidBackDepth } from "./android-bridge";
import { agentModels, effortLabelKey, effortOptions, groupModelsByProvider, modelDisplayLabel } from "./agent-model-options";
import { dispatchModeLabelKey } from "./dispatch-eligibility";
import { useI18n } from "./i18n";
import { backDepthFromState, QUICK_SETTINGS_HISTORY_MARKER } from "./navigation";
import type { AgentSessionSummary } from "./types";

/**
 * Mode, model and effort of one conversation, under the reply box (AND-158).
 * The model select keeps the person's choice separate from the model id the
 * Mac reports (a Claude alias can resolve to a different id). A pick applies immediately: these are one-click,
 * one-click-back changes, so the only confirmation is the pending note that
 * appears while the Mac has not answered (AND-130's revision handshake).
 */
export function AgentSessionQuickSettings({ session }: { session: AgentSessionSummary }) {
  const { t } = useI18n();
  const [moreOpen, setMoreOpen] = useState(false);
  const [showEffortNote, setShowEffortNote] = useState(false);
  useEffect(() => {
    if (!showEffortNote) return;
    const timer = window.setTimeout(() => setShowEffortNote(false), 5000);
    return () => window.clearTimeout(timer);
  }, [showEffortNote]);

  /**
   * The panel is a popup over the conversation, so back has to close it before
   * it closes the conversation under it (AND-199). It gets its own history
   * entry, the same shape the capture sheet uses: the phone's back gesture is
   * history, and only an entry of its own gives it something to unwind.
   * Choosing an option goes through closeMore too, so a pick cannot leave the
   * entry behind for a later back press to spend on nothing.
   */
  const openMore = () => {
    if (moreOpen) return;
    const current = typeof history.state === "object" && history.state
      ? history.state as Record<string, unknown>
      : {};
    history.pushState({ ...current, [QUICK_SETTINGS_HISTORY_MARKER]: true }, "");
    reportAndroidBackDepth(backDepthFromState(history.state));
    setMoreOpen(true);
  };
  const closeMore = useCallback(() => {
    if (history.state?.[QUICK_SETTINGS_HISTORY_MARKER]) {
      history.back();
      return;
    }
    setMoreOpen(false);
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const handlePopState = () => {
      if (!history.state?.[QUICK_SETTINGS_HISTORY_MARKER]) setMoreOpen(false);
    };
    // Escape closes it like any other dialog on this page.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMore();
    };
    window.addEventListener("popstate", handlePopState);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [moreOpen, closeMore]);

  // Leaving the conversation with the panel open must not leave its entry on
  // the stack: the next back press would spend itself on nothing visible.
  const moreOpenRef = useRef(false);
  moreOpenRef.current = moreOpen;
  useEffect(() => () => {
    if (moreOpenRef.current && history.state?.[QUICK_SETTINGS_HISTORY_MARKER]) history.back();
  }, []);
  const queryClient = useQueryClient();
  const settings = session.settings;
  const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes, enabled: Boolean(session.nodeId) });
  const models = agentModels(nodesQuery.data?.nodes.find((node) => node.id === session.nodeId), session.agentKind);

  const apply = useMutation({
    mutationFn: (change: { mode?: string; model?: string; effort?: string }) =>
      api.setAgentSessionSettings(session.agentSessionId!, change),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agent-sessions"] });
    },
  });

  const modeLabel = (value: string) => {
    const key = dispatchModeLabelKey(session.agentKind, value);
    return key ? t(key) : value;
  };
  const effortLabel = (value: string) => {
    const key = effortLabelKey(value);
    return key ? t(key) : value;
  };
  const endpointNote = settings.modelEndpoint ? ` · ${t("customModelEndpoint", { host: settings.modelEndpoint })}` : "";
  const requestedModel = settings.pending?.model ?? settings.requestedModel ?? "";
  // A refused change leaves the request in the server's history. Show the
  // Mac's previous value in the picker so the person can choose that code
  // again; the error explains why the requested change was refused.
  const modelValue = settings.error && !settings.pending ? settings.model ?? "" : requestedModel;
  const modelLabel = (id: string | undefined) => {
    const entry = models?.find((option) => option.id === id);
    return entry ? modelDisplayLabel(entry, models ?? []) : id || t("dispatchModelLocal");
  };
  const selectedModelLabel = modelLabel(modelValue);
  const shownEffort = settings.effort
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
  const changeMode = (mode: string) => {
    if (mode !== modeValue) apply.mutate({ mode });
    closeMore();
  };
  const changeEffort = (effort: string) => {
    if (effort && effort !== effortValue) {
      apply.mutate({ effort });
      if (session.agentKind === "codex") setShowEffortNote(true);
    }
    closeMore();
  };

  if (!settings.adjustable || !session.agentSessionId) {
    return (
      <div className="agent-session-quick-settings">
        <p className="agent-session-quick-settings-summary">
          {modeLabel(settings.mode)} · {shownEffort}
        </p>
        <p className="agent-session-settings-note" title={selectedModelLabel}>{modelLabel(settings.model ?? settings.requestedModel)}{endpointNote}</p>
        {settings.pending && <p className="agent-session-settings-note">{t("agentSettingsPending", { change: pendingText })}</p>}
        {settings.error && <p className="agent-session-settings-note error">{t("agentSettingsError", { error: settings.error })}</p>}
      </div>
    );
  }

  return (
    <div className="agent-session-quick-settings">
      <div className="agent-session-quick-settings-row">
        <select
          className="agent-settings-mode"
          aria-label={t("dispatchMode")}
          value={modeValue}
          disabled={apply.isPending}
          onChange={(event) => changeMode(event.target.value)}
        >
          {DISPATCH_MODES_BY_AGENT[session.agentKind].map((value) => (
            <option key={value} value={value}>{modeLabel(value)}</option>
          ))}
        </select>
        <select
          className="agent-settings-model"
          aria-label={t("dispatchModel")}
          value={modelValue}
          title={selectedModelLabel}
          disabled={apply.isPending || !models}
          onChange={(event) => {
            const model = event.target.value;
            if (model && model !== modelValue) apply.mutate({ model });
          }}
        >
          {/* Use the same catalog labels as dispatch, including pending picks. */}
          <option value={modelValue}>{selectedModelLabel}</option>
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
        </select>
        <select
          className="agent-settings-effort"
          aria-label={t("dispatchEffort")}
          value={effortValue}
          disabled={apply.isPending || !models}
          onChange={(event) => changeEffort(event.target.value)}
        >
          {effortValue && <option value={effortValue}>{shownEffort}</option>}
          {!effortValue && <option value="">{shownEffort}</option>}
          {effortOptions(models, modelValue).filter((value) => value !== effortValue).map((value) => (
            <option key={value} value={value}>{effortLabel(value)}</option>
          ))}
        </select>
        <div className="agent-settings-more">
          <button type="button" className="secondary-button" aria-label={t("moreActions")} aria-expanded={moreOpen} onClick={() => (moreOpen ? closeMore() : openMore())}><MoreHorizontal size={18} /></button>
          {moreOpen && <div className="agent-settings-more-panel">
            <label>{t("dispatchMode")}
              <select value={modeValue} disabled={apply.isPending} onChange={(event) => changeMode(event.target.value)}>
                {DISPATCH_MODES_BY_AGENT[session.agentKind].map((value) => <option key={value} value={value}>{modeLabel(value)}</option>)}
              </select>
            </label>
            <label>{t("dispatchEffort")}
              <select value={effortValue} disabled={apply.isPending || !models} onChange={(event) => changeEffort(event.target.value)}>
                {effortValue && <option value={effortValue}>{shownEffort}</option>}
                {!effortValue && <option value="">{shownEffort}</option>}
                {effortOptions(models, modelValue).filter((value) => value !== effortValue).map((value) => <option key={value} value={value}>{effortLabel(value)}</option>)}
              </select>
            </label>
          </div>}
        </div>
        {apply.isPending && <LoaderCircle className="spin" size={13} aria-hidden="true" />}
      </div>
      {endpointNote && <p className="agent-session-settings-note">{t("customModelEndpoint", { host: settings.modelEndpoint! })}</p>}
      {settings.pending && <p className="agent-session-settings-note">{t("agentSettingsPending", { change: pendingText })}</p>}
      {settings.error && <p className="agent-session-settings-note error">{t("agentSettingsError", { error: settings.error })}</p>}
      {apply.isError && (
        <p className="agent-session-settings-note error">
          {apply.error instanceof ApiError && apply.error.code === "node_upgrade_required"
            ? t("agentSettingsUpgrade")
            : apply.error instanceof Error ? apply.error.message : t("somethingWentWrong")}
        </p>
      )}
      {showEffortNote && <p className="agent-session-settings-note" role="status">{t("agentSettingsCodexEffortNote")}</p>}
    </div>
  );
}
