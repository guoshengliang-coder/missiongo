import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, SlidersHorizontal } from "lucide-react";

import { DISPATCH_MODES_BY_AGENT } from "@missiongo/domain";

import { api, ApiError } from "./api";
import { agentModels, effortLabelKey, effortOptions } from "./agent-model-options";
import { dispatchModeLabelKey } from "./dispatch-eligibility";
import { useI18n } from "./i18n";
import type { AgentSessionSummary } from "./types";

/**
 * Mode, model and effort of one conversation, and the control to change them
 * while it runs (AND-130). What is shown is what the Mac reported; a change
 * stays "waiting" until the Mac confirms it, because only the Mac can say the
 * agent actually switched.
 */
export function AgentSessionSettingsBar({ session }: { session: AgentSessionSummary }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const settings = session.settings;
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState(settings.mode);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes, enabled: editing });
  const models = agentModels(nodesQuery.data?.nodes.find((node) => node.id === session.nodeId), session.agentKind);

  useEffect(() => {
    setEditing(false);
  }, [session.id]);

  const apply = useMutation({
    mutationFn: () => api.setAgentSessionSettings(session.agentSessionId!, {
      ...(mode !== settings.mode ? { mode } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    }),
    onSuccess: async () => {
      setEditing(false);
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
  const changed = mode !== settings.mode || Boolean(model) || Boolean(effort);

  return (
    <div className="agent-session-settings">
      <p>
        {session.nodeName} · {modeLabel(settings.mode)} · {shownModel} · {shownEffort}
        {settings.adjustable && session.agentSessionId && !editing && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setMode(settings.mode);
              setModel("");
              setEffort("");
              setEditing(true);
            }}
          ><SlidersHorizontal size={13} /> {t("agentSettingsAdjust")}</button>
        )}
      </p>
      {settings.pending && <p className="agent-session-settings-note">{t("agentSettingsPending", { change: pendingText })}</p>}
      {settings.error && <p className="agent-session-settings-note error">{t("agentSettingsError", { error: settings.error })}</p>}
      {editing && (
        <form
          className="agent-session-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (changed) apply.mutate();
          }}
        >
          <select aria-label={t("dispatchMode")} value={mode} onChange={(event) => setMode(event.target.value)}>
            {DISPATCH_MODES_BY_AGENT[session.agentKind].map((value) => (
              <option key={value} value={value}>{modeLabel(value)}</option>
            ))}
          </select>
          <select
            aria-label={t("dispatchModel")}
            value={model}
            onChange={(event) => {
              setModel(event.target.value);
              setEffort("");
            }}
            disabled={!models}
          >
            <option value="">{shownModel}</option>
            {(models ?? []).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
          <select aria-label={t("dispatchEffort")} value={effort} onChange={(event) => setEffort(event.target.value)} disabled={!models}>
            <option value="">{shownEffort}</option>
            {effortOptions(models, model || settings.model).map((value) => (
              <option key={value} value={value}>{effortLabel(value)}</option>
            ))}
          </select>
          <button type="submit" className="secondary-button" disabled={!changed || apply.isPending}>
            {apply.isPending && <LoaderCircle className="spin" size={14} />}
            {t("agentSettingsApply")}
          </button>
          <button type="button" className="text-button" onClick={() => setEditing(false)}>{t("cancel")}</button>
          {session.agentKind === "codex" && <small>{t("agentSettingsCodexEffortNote")}</small>}
          {apply.isError && (
            <small className="error">
              {apply.error instanceof ApiError && apply.error.code === "node_upgrade_required"
                ? t("agentSettingsUpgrade")
                : apply.error instanceof Error ? apply.error.message : t("somethingWentWrong")}
            </small>
          )}
        </form>
      )}
    </div>
  );
}
