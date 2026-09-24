import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";

import { DISPATCH_MODES_BY_AGENT } from "@missiongo/domain";

import { api, ApiError } from "./api";
import { agentModels, effortLabelKey, effortOptions } from "./agent-model-options";
import { dispatchModeLabelKey } from "./dispatch-eligibility";
import { useI18n } from "./i18n";
import type { AgentSessionSummary } from "./types";

/**
 * Mode, model and effort of one conversation, under the reply box (AND-158).
 * Each select shows what is in effect -- what the Mac confirmed, or what is
 * still on its way -- and a pick applies immediately: these are one-click,
 * one-click-back changes, so the only confirmation is the pending note that
 * appears while the Mac has not answered (AND-130's revision handshake).
 */
export function AgentSessionQuickSettings({ session }: { session: AgentSessionSummary }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const settings = session.settings;
  const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes, enabled: settings.adjustable && Boolean(session.agentSessionId) });
  const models = agentModels(nodesQuery.data?.nodes.find((node) => node.id === session.nodeId), session.agentKind);

  const apply = useMutation({
    mutationFn: (change: { mode?: string; model?: string; effort?: string }) =>
      api.setAgentSessionSettings(session.agentSessionId!, change),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agent-sessions"] });
    },
  });

  const modeLabel = (value: string) => {
    const key = dispatchModeLabelKey(value);
    return key ? t(key) : value;
  };
  const effortLabel = (value: string) => {
    const key = effortLabelKey(value);
    return key ? t(key) : value;
  };
  const endpointNote = settings.modelEndpoint ? ` · ${t("customModelEndpoint", { host: settings.modelEndpoint })}` : "";
  const shownModel = settings.model
    ?? (settings.requestedModel ? `${settings.requestedModel}（${t("agentSettingsRequested")}）` : t("dispatchModelLocal"));
  const shownEffort = settings.effort
    ? effortLabel(settings.effort)
    : settings.requestedEffort
      ? `${effortLabel(settings.requestedEffort)}（${t("agentSettingsRequested")}）`
      : t("dispatchModelLocal");
  const pendingText = settings.pending
    ? [
        settings.pending.mode ? modeLabel(settings.pending.mode) : null,
        settings.pending.model ?? null,
        settings.pending.effort ? effortLabel(settings.pending.effort) : null,
      ].filter(Boolean).join(" · ")
    : "";

  // While a pick waits for the Mac, the select shows the picked value -- that is
  // what the person last said -- and the pending note below says it is not in
  // effect yet. If the Mac refuses it, the note turns into the error and the
  // selects fall back to what is confirmed.
  const modeValue = settings.pending?.mode ?? settings.mode;
  const modelValue = settings.pending?.model ?? settings.model ?? "";
  const effortValue = settings.pending?.effort ?? settings.effort ?? "";

  if (!settings.adjustable || !session.agentSessionId) {
    return (
      <div className="agent-session-quick-settings">
        <p className="agent-session-quick-settings-summary">
          {modeLabel(settings.mode)} · {shownModel}{endpointNote} · {shownEffort}
        </p>
        {settings.pending && <p className="agent-session-settings-note">{t("agentSettingsPending", { change: pendingText })}</p>}
        {settings.error && <p className="agent-session-settings-note error">{t("agentSettingsError", { error: settings.error })}</p>}
      </div>
    );
  }

  return (
    <div className="agent-session-quick-settings">
      <div className="agent-session-quick-settings-row">
        <select
          aria-label={t("dispatchMode")}
          value={modeValue}
          disabled={apply.isPending}
          onChange={(event) => {
            const mode = event.target.value;
            if (mode !== modeValue) apply.mutate({ mode });
          }}
        >
          {DISPATCH_MODES_BY_AGENT[session.agentKind].map((value) => (
            <option key={value} value={value}>{modeLabel(value)}</option>
          ))}
        </select>
        <select
          aria-label={t("dispatchModel")}
          value={modelValue}
          title={`${shownModel}${endpointNote}`}
          disabled={apply.isPending || !models}
          onChange={(event) => {
            const model = event.target.value;
            if (model && model !== modelValue) apply.mutate({ model });
          }}
        >
          {/* The current value as an option, so a model the list does not know
              (the resolved id the agent reported) never blanks the select. */}
          {modelValue && <option value={modelValue}>{shownModel}{endpointNote}</option>}
          {!modelValue && <option value="">{shownModel}{endpointNote}</option>}
          {(models ?? []).filter((entry) => entry.id !== modelValue).map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.label}</option>
          ))}
        </select>
        <select
          aria-label={t("dispatchEffort")}
          value={effortValue}
          disabled={apply.isPending || !models}
          onChange={(event) => {
            const effort = event.target.value;
            if (effort && effort !== effortValue) apply.mutate({ effort });
          }}
        >
          {effortValue && <option value={effortValue}>{shownEffort}</option>}
          {!effortValue && <option value="">{shownEffort}</option>}
          {effortOptions(models, modelValue).filter((value) => value !== effortValue).map((value) => (
            <option key={value} value={value}>{effortLabel(value)}</option>
          ))}
        </select>
        {apply.isPending && <LoaderCircle className="spin" size={13} aria-hidden="true" />}
      </div>
      {settings.pending && <p className="agent-session-settings-note">{t("agentSettingsPending", { change: pendingText })}</p>}
      {settings.error && <p className="agent-session-settings-note error">{t("agentSettingsError", { error: settings.error })}</p>}
      {apply.isError && (
        <p className="agent-session-settings-note error">
          {apply.error instanceof ApiError && apply.error.code === "node_upgrade_required"
            ? t("agentSettingsUpgrade")
            : apply.error instanceof Error ? apply.error.message : t("somethingWentWrong")}
        </p>
      )}
      {session.agentKind === "codex" && <p className="agent-session-settings-note">{t("agentSettingsCodexEffortNote")}</p>}
    </div>
  );
}
