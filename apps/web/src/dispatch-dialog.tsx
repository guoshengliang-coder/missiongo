import { HelpHint } from "./help-hint";
import { modeChoices, modeProblem, modeReasonKey } from "./agent-mode-options";
import { Select } from "./select";
import { useDialogDraft } from "./dialog-state";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePause, LoaderCircle, Rocket, TriangleAlert } from "lucide-react";

import { AGENT_KINDS, type AgentKind } from "@missiongo/domain";

import { api, ApiError } from "./api";
import { errorMessageKey, localizedErrorText } from "./error-text";
import { agentModels, effortLabelKey, effortOptions, groupModelsByProvider, modelDisplayLabel, reconcileEffort } from "./agent-model-options";
import { NODE_LIST_REFETCH_MS } from "./node-install";
import {
  ACTIVE_DISPATCHES_QUERY_KEY,
  ACTIVE_DISPATCHES_REFETCH_MS,
  activeDispatchStatusKey,
} from "./dispatch-conflicts";
import {
  NODE_INELIGIBILITY_KEYS,
  SUPPORTED_AGENT_KINDS,
  agentLabelKey,
  dispatchModeLabelKey,
  dispatchModeOrDefault,
  dispatchProblemKey,
  dispatchStatusLabelKey,
  nodeIneligibility,
  type NodeIneligibility,
} from "./dispatch-eligibility";
import { agentConsoleUrl } from "./navigation";
import { useI18n } from "./i18n";
import type { Dispatch, DispatchNode, FreeSessionConfig, Product, WorkItem } from "./types";

/**
 * Says why a machine cannot take this batch, in words that name the fix.
 * Exported nowhere: the reason is only ever read next to the machine it is about.
 */
function ineligibilityText(
  reason: NodeIneligibility,
  input: { readonly agentLabel: string; readonly productName: (productId: string) => string },
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (reason.reason === "agent_unavailable") return t("nodeAgentMissing", { agent: input.agentLabel });
  if (reason.reason === "agent_not_ready") {
    return reason.unavailableReason
      ? t("nodeAgentNotReadyReason", { agent: input.agentLabel, reason: reason.unavailableReason })
      : t("nodeAgentNotReady", { agent: input.agentLabel });
  }
  if (reason.reason === "repo_unmapped") {
    return t("nodeRepoUnmapped", { products: reason.productIds.map(input.productName).join("、") });
  }
  return t(NODE_INELIGIBILITY_KEYS[reason.reason]);
}

/** The server's own title is kept for codes this build does not know about. */
function dispatchErrorMessage(error: unknown, t: ReturnType<typeof useI18n>["t"], agent: string): string {
  if (error instanceof ApiError) {
    if (errorMessageKey(error)) return localizedErrorText(error, t);
    const key = dispatchProblemKey(error.code);
    // For a not-ready agent the server's title is the machine's own reason;
    // keep it as the {reason} rather than dropping it (AND-151).
    return key ? t(key, { agent, reason: error.message }) : error.message;
  }
  return error instanceof Error && error.message ? error.message : t("somethingWentWrong");
}

/**
 * Pick a machine, an agent and a mode for one batch of ready items.
 *
 * The whole batch goes to one session on one machine, which is why the machine
 * list is filtered against the batch rather than shown as a plain list of
 * hardware: a machine missing one product's repository is not a machine that can
 * run *these* items, and saying so here is the difference between a dispatch
 * that fails visibly and one that quietly never starts.
 *
 * Rendered inside the shared `Modal`, so it draws only the form.
 */
export function DispatchDialog({
  items,
  products,
  onDispatched,
  onClose,
  newSession,
  handoff,
}: {
  items: readonly WorkItem[];
  products: readonly Product[];
  onDispatched: (dispatch: Dispatch) => void;
  onClose: () => void;
  newSession?: { productId: string; initialConfig?: FreeSessionConfig; onConfigured: (config: FreeSessionConfig) => void };
  handoff?: {itemKey:string;expectedRevision:number;note:string;idempotencyKey:string};
}) {
  const { formatTime, t } = useI18n();
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState(newSession?.productId ?? "");
  const [touched, setTouched] = useState(false);
  const [agentKind, setAgentKind] = useState<AgentKind>(newSession?.initialConfig?.agentKind ?? "claude_code");
  const [mode, setMode] = useState<string>(dispatchModeOrDefault(newSession?.initialConfig?.agentKind ?? "claude_code",newSession?.initialConfig?.mode));
  const [nodeId, setNodeId] = useState(newSession?.initialConfig?.nodeId ?? "");
  // Empty means "as configured on the Mac" (AND-130).
  const [model, setModel] = useState(newSession?.initialConfig?.model ?? "");
  const [requestedEffort, setEffort] = useState(newSession?.initialConfig?.effort ?? "");
  const [effortResetFor, setEffortResetFor] = useState<string | null>(null);
  const [modeExplicit, setModeExplicit] = useState(Boolean(newSession?.initialConfig?.mode));
  const [defaultsApplied, setDefaultsApplied] = useState(Boolean(newSession?.initialConfig));
  // Held here rather than read back from the selection: dispatching clears the
  // selection, and the confirmation has to keep saying what was sent.
  const [created, setCreated] = useState<Dispatch | null>(null);
  // Which set of earlier dispatches the person said were gone, rather than a
  // plain boolean: if a refetch turns up another one, that tick was not about it.
  const requestKeys = useState(() => new Map<string,string>())[0];

  const nodesQuery = useQuery({
    queryKey: ["nodes"],
    queryFn: api.listNodes,
    // The dialog can wait out a machine that is momentarily not ready: readiness
    // travels with the heartbeat, and 30 seconds matches the rest of the console
    // (AND-151).
    refetchInterval: NODE_LIST_REFETCH_MS,
  });
  const isNewSession = Boolean(newSession);
  const nodes = useMemo(() => (nodesQuery.data?.nodes ?? []).filter(node => !isNewSession || node.supportsFreeSessions), [nodesQuery.data, isNewSession]);
  const defaultsQuery = useQuery({ queryKey: ["dispatch-defaults"], queryFn: api.getDispatchDefaults });

  // Start from the account's saved defaults once, before the person touches
  // anything. What no longer fits -- a machine gone, a model retired -- is
  // corrected by the effects below exactly as a manual pick would be.
  useEffect(() => {
    if (defaultsApplied || !defaultsQuery.isSuccess) return;
    setDefaultsApplied(true);
    const defaults = defaultsQuery.data;
    if (!defaults || touched) return;
    const kind = defaults.agentKind && SUPPORTED_AGENT_KINDS.includes(defaults.agentKind)
      ? defaults.agentKind
      : agentKind;
    const saved = defaults.agents[kind] ?? {};
    setAgentKind(kind);
    setMode(dispatchModeOrDefault(kind, saved.mode));
    setModeExplicit(Boolean(saved.mode));
    setModel(saved.model ?? "");
    setEffort(saved.effort ?? "");
    if (defaults.nodeId) setNodeId(defaults.nodeId);
  }, [agentKind, defaultsApplied, defaultsQuery.data, defaultsQuery.isSuccess, touched]);
  const itemKeys = useMemo(() => items.map((item) => item.key), [items]);
  const productIds = useMemo(() => isNewSession ? [projectId] : [...new Set(items.map((item) => item.productId))], [items, isNewSession, projectId]);
  const eligibility = useQuery({
    queryKey: [...ACTIVE_DISPATCHES_QUERY_KEY,"eligibility",...itemKeys],
    queryFn: () => api.checkRedispatch(itemKeys),
    enabled: itemKeys.length > 0 && !created && !handoff,
    refetchInterval: ACTIVE_DISPATCHES_REFETCH_MS,
  });
  // Eligibility is required before submission; the write repeats the same guard
  // so a dispatch delivered after this check cannot be replaced accidentally.
  const conflicts = handoff ? [] : eligibility.data?.conflicts ?? [];

  const ineligibility = useMemo(
    () => new Map(nodes.map((node) => [node.id, nodeIneligibility(node, { productIds, agentKind })])),
    [agentKind, nodes, productIds],
  );

  // Land on a machine that can actually take the batch. Changing the agent can
  // invalidate the current pick, so this runs on every change rather than once.
  useEffect(() => {
    if (nodes.length === 0 || (!defaultsApplied && !touched)) return;
    if (nodes.some((node) => node.id === nodeId && !ineligibility.get(node.id))) return;
    const firstEligible = nodes.find((node) => !ineligibility.get(node.id));
    setNodeId(firstEligible?.id ?? nodes[0]!.id);
  }, [defaultsApplied, touched, ineligibility, nodeId, nodes]);

  const selectedAgent = nodes.find(node=>node.id===nodeId)?.agents.find(agent=>agent.kind===agentKind);
  useEffect(() => {
    // Cached defaults and this effect can run in the same mount. Wait for the
    // defaults transaction before deriving a mode from the previous render.
    if ((defaultsApplied || touched) && !modeExplicit) setMode(dispatchModeOrDefault(agentKind,undefined,selectedAgent?.modes,model || undefined));
  },[defaultsApplied,touched,agentKind,modeExplicit,selectedAgent?.modes,model]);
  const modeIssue = modeProblem(agentKind,mode,selectedAgent?.modes,model || undefined);
  const models = agentModels(nodes.find((node) => node.id === nodeId), agentKind);
  const modelUnavailable=Boolean(model && models && !models.some(entry=>entry.id===model));
  // Derive the submitted value in this render too: an effect alone leaves a
  // window where the visible fallback and the request still disagree.
  const effort = reconcileEffort(models, { model, effort: requestedEffort }).effort ?? "";
  const catalogUnavailable = Boolean(!models && (model || requestedEffort));
  const choiceKey = `${nodeId}|${agentKind}|${model}`;
  useEffect(() => {
    if (effort === requestedEffort) return;
    setEffort(effort);
    setEffortResetFor(choiceKey);
  }, [effort, requestedEffort, choiceKey]);

  const defaultsKey = JSON.stringify([nodeId, agentKind, mode, model, effort]);
  const [saveDefaultsFor, setSaveDefaultsFor] = useState<string | null>(null);
  useEffect(() => setSaveDefaultsFor(null), [defaultsKey]);
  const saved = defaultsQuery.data;
  const savedAgent = saved?.agents[agentKind];
  const differsFromDefaults = Boolean(saved && (saved.nodeId !== nodeId || saved.agentKind !== agentKind
    || savedAgent?.mode !== mode || (savedAgent?.model ?? "") !== model || (savedAgent?.effort ?? "") !== effort));
  const saveAsDefault = differsFromDefaults && saveDefaultsFor === defaultsKey;

  const mutation = useMutation({
    // `force` only ever follows the tick: without conflicts it is left off, so
    // a dispatch that raced another one is refused instead of silently doubled.
    mutationFn: async () => {
      const config={nodeId,agentKind,mode,saveAsDefault,...(model?{model}:{}),...(effort?{effort}:{})};
      if(handoff) {
        const result=await api.createAgentHandoff(handoff.itemKey,{expectedRevision:handoff.expectedRevision,note:handoff.note,
          idempotencyKey:handoff.idempotencyKey,target:{kind:"dispatch",...config}});
        if(!result.dispatch) throw new Error(t("agentHandoffChanged"));
        return result.dispatch;
      }
      return api.createDispatch({
      nodeId,
      agentKind,
      mode,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      itemKeys,
      saveAsDefault,
      idempotencyKey: (() => {
        const signature=JSON.stringify([nodeId,agentKind,mode,model,effort,itemKeys,saveAsDefault]);
        if(!requestKeys.has(signature)) requestKeys.set(signature,crypto.randomUUID());
        return requestKeys.get(signature)!;
      })(),
      });
    },
    onSuccess: (dispatch) => {
      void queryClient.invalidateQueries({ queryKey: ["dispatch-defaults"] });
      setCreated(dispatch);
      onDispatched(dispatch);
    },
    onError: (error) => {
      // Someone dispatched one of these after the dialog last looked. Fetch now
      // so the notice and its checkbox are there when the person reads the error.
      if (error instanceof ApiError && error.code === "item_already_dispatched") {
        void queryClient.invalidateQueries({ queryKey: ACTIVE_DISPATCHES_QUERY_KEY });
      }
    },
  });

  // A dispatch error belongs to the choices that produced it. Changing the
  // machine, agent, mode, model or effort -- including the automatic jump to an
  // eligible machine -- makes it stale, so it must not outlive its cause
  // (AND-151). The conflict tick is in the key because unticking it changes what
  // would be submitted.
  const submissionKey = `${nodeId}|${agentKind}|${mode}|${model}|${effort}`;
  useEffect(() => {
    if (mutation.isError) mutation.reset();
    // Keyed on the values, not the error: resetting clears the error, and
    // depending on it would run the effect again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionKey]);

  const productName = (productId: string) =>
    products.find((product) => product.id === productId)?.name ?? productId;
  const agentLabel = (kind: AgentKind) => {
    const key = agentLabelKey(kind);
    return key ? t(key) : kind;
  };
  // A mode the server offers that this build has no wording for is still shown,
  // as the value itself, rather than dropped from the list.
  const modeLabel = (kind: string, value: string) => {
    const key = dispatchModeLabelKey(kind, value);
    return key ? t(key) : value;
  };
  const effortLabel = (value: string) => {
    const key = effortLabelKey(value);
    return key ? t(key) : value;
  };
  const nodeLabel = (node: DispatchNode) => {
    const reason = ineligibility.get(node.id);
    if (!reason) return node.name;
    return `${node.name} · ${ineligibilityText(reason, { agentLabel: agentLabel(agentKind), productName }, t)}`;
  };

  useDialogDraft(touched && !created, mutation.isPending);

  if (created) {
    const statusKey = dispatchStatusLabelKey(created.status);
    return (
      <div className="dispatch-result">
        <p className="dispatch-result-headline"><Rocket size={16} /> {t("dispatchSent", { node: created.nodeName })}</p>
        <div className="context-grid">
          <span><small>{t("dispatchAgent")}</small>{agentLabel(created.agentKind)}</span>
          <span><small>{t("dispatchMode")}</small>{modeLabel(created.agentKind, created.mode)}</span>
          <span><small>{t("dispatchModel")}</small>{created.model ?? t("dispatchModelLocal")}</span>
          <span><small>{t("dispatchEffort")}</small>{created.effort ? effortLabel(created.effort) : t("dispatchModelLocal")}</span>
          <span><small>{t("status")}</small>{statusKey ? t(statusKey) : created.status}</span>
          <span><small>{t("dispatchItemsLabel")}</small>{created.itemKeys.join("、")}</span>
          {created.sessionName && <span><small>{t("dispatchSessionName")}</small>{created.sessionName}</span>}
        </div>
        {created.error && <div className="inline-error"><CirclePause size={16} /><span>{created.error}</span></div>}
        <p className="dispatch-note">{t("dispatchSessionPending")}</p>
        <div className="dispatch-note help-label"><span>{t(newSession ? "newSessionDraftHint" : "dispatchScopeShort")}</span><HelpHint title={t(newSession ? "newSession" : "dispatchSubmit")}><p>{t(newSession ? "newSessionDraftHint" : "dispatchDoesNotClaim")}</p></HelpHint></div>
        <div className="form-footer">
          <button type="button" className="primary-button" onClick={onClose}>{t("close")}</button>
        </div>
      </div>
    );
  }

  const selectedReason = nodeId ? ineligibility.get(nodeId) ?? null : null;
  const modes = modeChoices(agentKind,mode,selectedAgent?.modes,model || undefined);

  const blocked = !nodeId || Boolean(selectedReason) || (newSession ? !products.some(product => product.id === projectId) || !nodes.some(node => node.id === nodeId)
    : itemKeys.length === 0 || (!handoff && (!eligibility.isSuccess || !eligibility.data.allowed)));

  return (
    <form
      className="dispatch-form" onChangeCapture={() => setTouched(true)}
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked) return;
        if (modeIssue || modelUnavailable || catalogUnavailable) return;
        if (newSession) newSession.onConfigured({productId:projectId,nodeId,agentKind,mode,saveAsDefault,
          ...(model ? {model} : {}), ...(effort ? {effort} : {}),
          nodeName:nodes.find(node => node.id === nodeId)?.name ?? "",
          canAttach:nodes.find(node => node.id === nodeId)?.supportsChatAttachments === true});
        else mutation.mutate();
      }}
    >
      {newSession && <label>{t("newSessionProject")}<Select value={projectId} onChange={event => setProjectId(event.target.value)}>
        {products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}
      </Select></label>}
      {!newSession && <div className="dispatch-items">
        <p className="eyebrow">{t("dispatchItemsLabel")}</p>
        <ul>
          {items.map((item) => (
            <li key={item.key}><code>{item.key}</code><span>{item.title}</span></li>
          ))}
        </ul>
      </div>}

      {eligibility.data?.allowed === false && eligibility.data.reason !== "item_not_dispatchable" && <p className="dispatch-conflict" role="alert">{t("dispatchParallelUpgrade")}</p>}
      {Boolean(eligibility.data?.takeoverWarnings?.length) && <p className="dispatch-conflict" role="status">{t("executionTakeoverHelp")}</p>}
      {!conflicts.length && eligibility.data?.reason === "execution_unconfirmed" && <p className="dispatch-conflict" role="alert">{t("executionStopBlocked")}</p>}
      {conflicts.length > 0 && (
        <div className="dispatch-conflict" role="status">
          <p className="dispatch-conflict-heading"><TriangleAlert size={15} aria-hidden="true" /> {t("dispatchConflictHeading")}</p>
          <ul>
            {conflicts.map((entry) => {
              const statusKey = activeDispatchStatusKey(entry.status);
              return (
                <li key={`${entry.itemKey}:${entry.dispatchId}`}>
                  {t("dispatchConflictLine", {
                    key: entry.itemKey,
                    node: entry.nodeName,
                    status: statusKey ? t(statusKey) : entry.status,
                    time: formatTime(entry.createdAt),
                  })}
                  {entry.agentSessionId && <> <a href={agentConsoleUrl(entry.agentSessionId)}>{t("openDispatchInConsole")}</a></>}
                </li>
              );
            })}
          </ul>
          <p>{t("dispatchConflictExplain")}</p>
        </div>
      )}

      {eligibility.isError && <div className="inline-error" role="alert">{localizedErrorText(eligibility.error,t)} <button type="button" onClick={()=>void eligibility.refetch()}>{t("retry")}</button></div>}
      <label>{t("dispatchNode")}
        <Select value={nodeId} onChange={(event) => setNodeId(event.target.value)} disabled={nodes.length === 0}>
          {nodes.map((node) => (
            <option key={node.id} value={node.id} disabled={Boolean(ineligibility.get(node.id))}>
              {nodeLabel(node)}
            </option>
          ))}
        </Select>
      </label>
      {nodesQuery.isLoading && <p className="section-empty"><LoaderCircle className="spin" size={14} /></p>}
      {/* A failed request is not an empty machine room: saying "no devices"
          here sent people to install a client the server simply failed to
          list (AND-224). */}
      {nodesQuery.isError && (
        <p className="section-empty" role="alert">
          {t("dispatchNodesFailed", { error: localizedErrorText(nodesQuery.error, t) })}{" "}
          <button type="button" className="attachment-load-button" onClick={() => void nodesQuery.refetch()}>
            {t("retry")}
          </button>
        </p>
      )}
      {!nodesQuery.isLoading && !nodesQuery.isError && nodes.length === 0 && <p className="section-empty">{t(newSession ? "newSessionNodeUpdate" : "dispatchNoNodes")}</p>}
      {/* The reason is on the option too, but a select shows one line at a time:
          without this the submit button is disabled with the explanation hidden
          inside a closed dropdown. */}
      {selectedReason && (
        <p className="dispatch-blocked">
          {ineligibilityText(selectedReason, { agentLabel: agentLabel(agentKind), productName }, t)}
        </p>
      )}

      <div className="field-row">
        <label>{t("dispatchAgent")}
          <Select
            value={agentKind}
            onChange={(event) => {
              const next = event.target.value as AgentKind;
              const saved = defaultsQuery.data?.agents[next] ?? {};
              setAgentKind(next);
              // A mode from the previous agent is not a preference for this one.
              // Models are per agent too, so start from that agent's saved default.
              setMode(dispatchModeOrDefault(next, saved.mode));
              setModeExplicit(Boolean(saved.mode));
              setModel(saved.model ?? "");
              setEffort(saved.effort ?? "");
            }}
          >
            {AGENT_KINDS.map((kind) => {
              const supported = SUPPORTED_AGENT_KINDS.includes(kind);
              return (
                <option key={kind} value={kind} disabled={!supported}>
                  {supported ? agentLabel(kind) : `${agentLabel(kind)} · ${t("agentNotSupportedYet")}`}
                </option>
              );
            })}
          </Select>
        </label>
        <label>{t("dispatchMode")}
          <Select value={mode} onChange={(event) => {setMode(event.target.value);setModeExplicit(true);}}>
            <option value="" disabled>{t("dispatchModeChoose")}</option>
            {modes.map(choice => <option key={choice.value} value={choice.value} disabled={choice.state!=="available"}>
              {modeLabel(agentKind,choice.value)}{choice.state!=="available" ? ` · ${t(modeReasonKey(choice))}` : ""}
            </option>)}
          </Select>
        </label>
      </div>
      {modelUnavailable && <p className="dispatch-note" role="status">{t("dispatchModelUnavailable", { model })}</p>}
      {modeIssue && <p className="dispatch-note" role="status">{t(modeIssue)}</p>}
      <div className="field-row">
        <label>{t("dispatchModel")}
          <Select value={model} onChange={(event) => setModel(event.target.value)} disabled={!models}>
            <option value="">{t("dispatchModelLocal")}</option>
            {model && (!models || modelUnavailable) && <option value={model}>{model}</option>}
            {groupModelsByProvider(models ?? []).map((group) => (
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
        </label>
        <label>{t("dispatchEffort")}
          <Select value={effort} onChange={(event) => { setEffort(event.target.value); setEffortResetFor(null); }} disabled={!models}>
            <option value="">{t("dispatchModelLocal")}</option>
            {effort && !effortOptions(models, model || undefined).includes(effort) && <option value={effort} disabled>{effortLabel(effort)}</option>}
            {effortOptions(models, model || undefined).map((value) => (
              <option key={value} value={value}>{effortLabel(value)}</option>
            ))}
          </Select>
        </label>
      </div>
      {effortResetFor === choiceKey && <p className="dispatch-note" role="status">{t("dispatchEffortReset", { model: models?.find(entry => entry.id === model)?.label ?? (model || t("dispatchModelLocal")) })}</p>}
      {nodeId && !models && nodesQuery.isFetched && <p className="dispatch-note">{t("dispatchModelUnsupported")}</p>}
      <div className="dispatch-note help-label"><span>{t(newSession ? "newSessionDraftHint" : "dispatchScopeShort")}</span><HelpHint title={t(newSession ? "newSession" : "dispatchSubmit")}><p>{t(newSession ? "newSessionDraftHint" : "dispatchDoesNotClaim")}</p></HelpHint></div>

      {mutation.isError && (
        <div className="inline-error"><CirclePause size={16} /><span>{dispatchErrorMessage(mutation.error, t, agentLabel(agentKind))}</span></div>
      )}

      {defaultsQuery.isError && <p className="inline-error" role="alert">{t("dispatchDefaultsUnavailable")}
        <button type="button" className="secondary-button" onClick={() => void defaultsQuery.refetch()}>{t("retry")}</button>
      </p>}
      {differsFromDefaults && <div className="help-option"><label className="dispatch-conflict-confirm">
        <input type="checkbox" checked={saveAsDefault} disabled={mutation.isPending}
          onChange={event => setSaveDefaultsFor(event.target.checked ? defaultsKey : null)} />
        <span>{t("dispatchSetDefaults")}</span>
      </label><HelpHint title={t("dispatchSetDefaults")}><p>{t("dispatchDefaultHelp")}</p></HelpHint></div>}
      <div className="form-footer">
        <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={onClose}>{t(handoff ? "agentHandoffBack" : "cancel")}</button>
        <button type="submit" className="primary-button" disabled={Boolean(modeIssue) || modelUnavailable || catalogUnavailable || blocked || !defaultsApplied || mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="spin" size={16} /> : <Rocket size={16} />}
          {t(newSession ? "newSessionEnter" : handoff ? "agentHandoffConfirm" : eligibility.data?.takeoverWarnings?.length ? "executionStartTakeover" : "dispatchSubmit")}
        </button>
      </div>
    </form>
  );
}
