import { Select } from "./select";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CirclePause, LoaderCircle } from "lucide-react";

import { DISPATCH_MODES_BY_AGENT, type AgentKind } from "@missiongo/domain";

import { api } from "./api";
import { useSettingsDraft } from "./settings-drafts";
import { effortLabelKey, effortOptions, groupModelsByProvider, modelDisplayLabel, modelsAcrossNodes } from "./agent-model-options";
import { SUPPORTED_AGENT_KINDS, agentLabelKey, dispatchModeLabelKey, dispatchModeOrDefault } from "./dispatch-eligibility";
import { useI18n } from "./i18n";
import type { DispatchDefaults } from "./types";

/**
 * Where the dispatch dialog starts (AND-130). Per account, next to the Macs,
 * because the machine is part of it. Models come from every Mac's report: a
 * default is not tied to one machine, and the dialog drops a model the chosen
 * Mac does not offer.
 */
export function DispatchDefaultsSettings({ onOpenDevices }: { onOpenDevices: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes });
  const defaultsQuery = useQuery({ queryKey: ["dispatch-defaults"], queryFn: api.getDispatchDefaults });
  const [draft, setDraft] = useState<DispatchDefaults | null>(null);
  const [saved, setSaved] = useState(false);
  const nodes = nodesQuery.data?.nodes ?? [];

  useEffect(() => {
    if (defaultsQuery.data && draft === null) setDraft(defaultsQuery.data);
  }, [defaultsQuery.data, draft]);

  const save = useMutation({
    mutationFn: (value: DispatchDefaults) => api.setDispatchDefaults(value),
    onSuccess: (value) => {
      queryClient.setQueryData(["dispatch-defaults"], value);
      setDraft(value);
      setSaved(true);
    },
  });

  useSettingsDraft(draft !== null && JSON.stringify(draft) !== JSON.stringify(defaultsQuery.data), save.isPending);

  if (nodesQuery.isError || defaultsQuery.isError) return <p role="alert">{t("settingsLoadFailed")} <button type="button" className="secondary-button" onClick={() => { void nodesQuery.refetch(); void defaultsQuery.refetch(); }}>{t("retry")}</button></p>;

  if (!draft || nodesQuery.isPending) {
    return (
      <section className="product-settings-section">
        <header><div><h3>{t("dispatchDefaultsTitle")}</h3></div></header>
        <p className="section-empty"><LoaderCircle className="spin" size={14} /></p>
      </section>
    );
  }

  const available = SUPPORTED_AGENT_KINDS.filter(kind => nodes.some(node => !node.revokedAt && node.agents.some(agent => agent.kind === kind)));
  if (available.length === 0) return <section className="settings-empty"><h3>{t("settingsConnectDeviceFirst")}</h3><p>{t("settingsDispatchNeedsDevice")}</p><button type="button" className="primary-button" onClick={onOpenDevices}>{t("settingsDevices")}</button></section>;

  const update = (next: DispatchDefaults) => {
    setDraft(next);
    setSaved(false);
  };
  const updateAgent = (kind: AgentKind, change: { mode?: string; model?: string; effort?: string }) => {
    const current = draft.agents[kind] ?? {};
    const merged = { ...current, ...change };
    const cleaned = Object.fromEntries(Object.entries(merged).filter(([, value]) => value));
    update({ ...draft, agents: { ...draft.agents, [kind]: cleaned } });
  };
  const label = (key: ReturnType<typeof agentLabelKey>, fallback: string) => (key ? t(key) : fallback);
  const effortLabel = (value: string) => {
    const key = effortLabelKey(value);
    return key ? t(key) : value;
  };

  return (
    <section className="product-settings-section dispatch-defaults">
      <header><div><h3>{t("dispatchDefaultsTitle")}</h3></div></header>
      <p className="component-management-help">{t("dispatchDefaultsHelp")}</p>
      <form
        className="dispatch-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(draft);
        }}
      >
        <div className="field-row">
          <label>{t("dispatchNode")}
            <Select
              value={draft.nodeId ?? ""}
              onChange={(event) => {
                const { nodeId: _previous, ...rest } = draft;
                update(event.target.value ? { ...rest, nodeId: event.target.value } : rest);
              }}
            >
              <option value="">{t("dispatchDefaultsNodeAny")}</option>
              {nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
            </Select>
          </label>
          <label>{t("dispatchAgent")}
            <Select
              value={draft.agentKind ?? "claude_code"}
              onChange={(event) => update({ ...draft, agentKind: event.target.value as AgentKind })}
            >
              {Array.from(new Set([draft.agentKind ?? "claude_code", ...available])).map((kind) => (
                <option key={kind} value={kind}>{label(agentLabelKey(kind), kind)}</option>
              ))}
            </Select>
          </label>
        </div>
        {[draft.agentKind ?? "claude_code"].map((kind) => {
          const current = draft.agents[kind] ?? {};
          const models = modelsAcrossNodes(nodes, kind);
          return (
            <fieldset key={kind} className="dispatch-defaults-agent">
              <legend>{label(agentLabelKey(kind), kind)}</legend>
              <div className="field-row">
                <label>{t("dispatchMode")}
                  <Select value={dispatchModeOrDefault(kind, current.mode)} onChange={(event) => updateAgent(kind, { mode: event.target.value })}>
                    {DISPATCH_MODES_BY_AGENT[kind].map((value) => (
                      <option key={value} value={value}>{label(dispatchModeLabelKey(kind, value), value)}</option>
                    ))}
                  </Select>
                </label>
                <details className="settings-advanced"><summary>{t("settingsAdvancedModel")}</summary>
                <div className="field-row">
                <label>{t("dispatchModel")}
                  <Select
                    value={current.model ?? ""}
                    onChange={(event) => updateAgent(kind, { model: event.target.value, effort: "" })}
                  >
                    <option value="">{t("dispatchModelLocal")}</option>
                    {groupModelsByProvider(models).map((group) => (
                      group.provider === null
                        ? group.models.map((model) => (
                          <option key={model.id} value={model.id}>{modelDisplayLabel(model, models)}</option>
                        ))
                        : (
                          <optgroup key={group.provider} label={group.provider}>
                            {group.models.map((model) => (
                              <option key={model.id} value={model.id}>{modelDisplayLabel(model, models)}</option>
                            ))}
                          </optgroup>
                        )
                    ))}
                    {current.model && !models.some((model) => model.id === current.model) && (
                      <option value={current.model}>{current.model}</option>
                    )}
                  </Select>
                </label>
                <label>{t("dispatchEffort")}
                  <Select value={current.effort ?? ""} onChange={(event) => updateAgent(kind, { effort: event.target.value })}>
                    <option value="">{t("dispatchModelLocal")}</option>
                    {effortOptions(models, current.model).map((value) => (
                      <option key={value} value={value}>{effortLabel(value)}</option>
                    ))}
                  </Select>
                </label>
                </div>
                </details>
              </div>
            </fieldset>
          );
        })}
        {save.isError && (
          <div className="inline-error"><CirclePause size={16} /><span>{save.error instanceof Error ? save.error.message : t("somethingWentWrong")}</span></div>
        )}
        <div className="form-footer">
          <button type="button" className="secondary-button" disabled={save.isPending} onClick={() => { setDraft(defaultsQuery.data ?? null); setSaved(false); }}>{t("cancel")}</button>
          {saved && <span className="dispatch-defaults-saved"><Check size={14} /> {t("dispatchDefaultsSaved")}</span>}
          <button type="submit" className="primary-button" disabled={save.isPending || JSON.stringify(draft) === JSON.stringify(defaultsQuery.data)}>
            {save.isPending && <LoaderCircle className="spin" size={15} />}
            {t("save")}
          </button>
        </div>
      </form>
    </section>
  );
}
