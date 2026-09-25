import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CirclePause, LoaderCircle } from "lucide-react";

import { DISPATCH_MODES_BY_AGENT, type AgentKind } from "@missiongo/domain";

import { api } from "./api";
import { effortLabelKey, effortOptions, groupModelsByProvider, modelsAcrossNodes } from "./agent-model-options";
import { SUPPORTED_AGENT_KINDS, agentLabelKey, dispatchModeLabelKey } from "./dispatch-eligibility";
import { useI18n } from "./i18n";
import type { DispatchDefaults } from "./types";

/**
 * Where the dispatch dialog starts (AND-130). Per account, next to the Macs,
 * because the machine is part of it. Models come from every Mac's report: a
 * default is not tied to one machine, and the dialog drops a model the chosen
 * Mac does not offer.
 */
export function DispatchDefaultsSettings() {
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

  if (!draft) {
    return (
      <section className="product-settings-section">
        <header><div><h3>{t("dispatchDefaultsTitle")}</h3></div></header>
        <p className="section-empty"><LoaderCircle className="spin" size={14} /></p>
      </section>
    );
  }

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
            <select
              value={draft.nodeId ?? ""}
              onChange={(event) => {
                const { nodeId: _previous, ...rest } = draft;
                update(event.target.value ? { ...rest, nodeId: event.target.value } : rest);
              }}
            >
              <option value="">{t("dispatchDefaultsNodeAny")}</option>
              {nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
            </select>
          </label>
          <label>{t("dispatchAgent")}
            <select
              value={draft.agentKind ?? "claude_code"}
              onChange={(event) => update({ ...draft, agentKind: event.target.value as AgentKind })}
            >
              {SUPPORTED_AGENT_KINDS.map((kind) => (
                <option key={kind} value={kind}>{label(agentLabelKey(kind), kind)}</option>
              ))}
            </select>
          </label>
        </div>
        {SUPPORTED_AGENT_KINDS.map((kind) => {
          const current = draft.agents[kind] ?? {};
          const models = modelsAcrossNodes(nodes, kind);
          return (
            <fieldset key={kind} className="dispatch-defaults-agent">
              <legend>{label(agentLabelKey(kind), kind)}</legend>
              <div className="field-row">
                <label>{t("dispatchMode")}
                  <select value={current.mode ?? (kind === "claude_code" ? "bypassPermissions" : "plan")} onChange={(event) => updateAgent(kind, { mode: event.target.value })}>
                    {DISPATCH_MODES_BY_AGENT[kind].map((value) => (
                      <option key={value} value={value}>{label(dispatchModeLabelKey(kind, value), value)}</option>
                    ))}
                  </select>
                </label>
                <label>{t("dispatchModel")}
                  <select
                    value={current.model ?? ""}
                    onChange={(event) => updateAgent(kind, { model: event.target.value, effort: "" })}
                  >
                    <option value="">{t("dispatchModelLocal")}</option>
                    {groupModelsByProvider(models).map((group) => (
                      group.provider === null
                        ? group.models.map((model) => (
                          <option key={model.id} value={model.id}>{model.label}</option>
                        ))
                        : (
                          <optgroup key={group.provider} label={group.provider}>
                            {group.models.map((model) => (
                              <option key={model.id} value={model.id}>{model.label}</option>
                            ))}
                          </optgroup>
                        )
                    ))}
                    {current.model && !models.some((model) => model.id === current.model) && (
                      <option value={current.model}>{current.model}</option>
                    )}
                  </select>
                </label>
                <label>{t("dispatchEffort")}
                  <select value={current.effort ?? ""} onChange={(event) => updateAgent(kind, { effort: event.target.value })}>
                    <option value="">{t("dispatchModelLocal")}</option>
                    {effortOptions(models, current.model).map((value) => (
                      <option key={value} value={value}>{effortLabel(value)}</option>
                    ))}
                  </select>
                </label>
              </div>
            </fieldset>
          );
        })}
        {save.isError && (
          <div className="inline-error"><CirclePause size={16} /><span>{save.error instanceof Error ? save.error.message : t("somethingWentWrong")}</span></div>
        )}
        <div className="form-footer">
          {saved && <span className="dispatch-defaults-saved"><Check size={14} /> {t("dispatchDefaultsSaved")}</span>}
          <button type="submit" className="primary-button" disabled={save.isPending}>
            {save.isPending && <LoaderCircle className="spin" size={15} />}
            {t("save")}
          </button>
        </div>
      </form>
    </section>
  );
}
