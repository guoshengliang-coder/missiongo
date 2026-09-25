import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePause, LoaderCircle, Rocket, TriangleAlert } from "lucide-react";

import { AGENT_KINDS, DISPATCH_MODES_BY_AGENT, type AgentKind } from "@missiongo/domain";

import { api, ApiError } from "./api";
import { agentModels, effortLabelKey, effortOptions, groupModelsByProvider, reconcileChoice } from "./agent-model-options";
import {
  ACTIVE_DISPATCHES_QUERY_KEY,
  ACTIVE_DISPATCHES_REFETCH_MS,
  activeDispatchStatusKey,
  dispatchesByItem,
  conflictSignature,
  dispatchConflicts,
  includesQueued,
} from "./dispatch-conflicts";
import {
  NODE_INELIGIBILITY_KEYS,
  SUPPORTED_AGENT_KINDS,
  agentLabelKey,
  dispatchModeHelpKey,
  dispatchModeLabelKey,
  dispatchProblemKey,
  dispatchStatusLabelKey,
  nodeIneligibility,
  type NodeIneligibility,
} from "./dispatch-eligibility";
import { SessionLink } from "./session-link";
import { useI18n } from "./i18n";
import type { Dispatch, DispatchNode, Product, WorkItem } from "./types";

/** The account owner chose unattended dispatch; hard deny rules remain on the Mac node. */
const DEFAULT_MODE = "bypassPermissions";

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
  if (reason.reason === "repo_unmapped") {
    return t("nodeRepoUnmapped", { products: reason.productIds.map(input.productName).join("、") });
  }
  return t(NODE_INELIGIBILITY_KEYS[reason.reason]);
}

/** The server's own title is kept for codes this build does not know about. */
function dispatchErrorMessage(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (error instanceof ApiError) {
    const key = dispatchProblemKey(error.code);
    return key ? t(key) : error.message;
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
}: {
  items: readonly WorkItem[];
  products: readonly Product[];
  onDispatched: (dispatch: Dispatch) => void;
  onClose: () => void;
}) {
  const { formatTime, t } = useI18n();
  const queryClient = useQueryClient();
  const [agentKind, setAgentKind] = useState<AgentKind>("claude_code");
  const [mode, setMode] = useState<string>(DEFAULT_MODE);
  const [nodeId, setNodeId] = useState("");
  // Empty means "as configured on the Mac" (AND-130).
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [defaultsApplied, setDefaultsApplied] = useState(false);
  // Held here rather than read back from the selection: dispatching clears the
  // selection, and the confirmation has to keep saying what was sent.
  const [created, setCreated] = useState<Dispatch | null>(null);
  // Which set of earlier dispatches the person said were gone, rather than a
  // plain boolean: if a refetch turns up another one, that tick was not about it.
  const [acknowledgedConflicts, setAcknowledgedConflicts] = useState<string | null>(null);

  const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes });
  const nodes = nodesQuery.data?.nodes ?? [];
  const defaultsQuery = useQuery({ queryKey: ["dispatch-defaults"], queryFn: api.getDispatchDefaults });

  // Start from the account's saved defaults once, before the person touches
  // anything. What no longer fits -- a machine gone, a model retired -- is
  // corrected by the effects below exactly as a manual pick would be.
  useEffect(() => {
    if (defaultsApplied || !defaultsQuery.isFetched) return;
    setDefaultsApplied(true);
    const defaults = defaultsQuery.data;
    if (!defaults) return;
    const kind = defaults.agentKind && SUPPORTED_AGENT_KINDS.includes(defaults.agentKind)
      ? defaults.agentKind
      : agentKind;
    const saved = defaults.agents[kind] ?? {};
    setAgentKind(kind);
    if (saved.mode && DISPATCH_MODES_BY_AGENT[kind].includes(saved.mode)) setMode(saved.mode);
    setModel(saved.model ?? "");
    setEffort(saved.effort ?? "");
    if (defaults.nodeId) setNodeId(defaults.nodeId);
  }, [agentKind, defaultsApplied, defaultsQuery.data, defaultsQuery.isFetched]);
  const itemKeys = useMemo(() => items.map((item) => item.key), [items]);
  const productIds = useMemo(() => [...new Set(items.map((item) => item.productId))], [items]);
  const activeQuery = useQuery({
    queryKey: ACTIVE_DISPATCHES_QUERY_KEY,
    queryFn: api.listActiveDispatches,
    refetchInterval: ACTIVE_DISPATCHES_REFETCH_MS,
  });
  // Not waited for: while it loads, or if it fails, the server still refuses a
  // second dispatch, and that refusal brings the notice below with it.
  const conflicts = useMemo(
    () => dispatchConflicts(itemKeys, dispatchesByItem(activeQuery.data?.active ?? [])),
    [activeQuery.data, itemKeys],
  );
  const conflictsKey = conflictSignature(conflicts);
  const redispatchConfirmed = conflicts.length > 0 && acknowledgedConflicts === conflictsKey;
  const ineligibility = useMemo(
    () => new Map(nodes.map((node) => [node.id, nodeIneligibility(node, { productIds, agentKind })])),
    [agentKind, nodes, productIds],
  );

  // Land on a machine that can actually take the batch. Changing the agent can
  // invalidate the current pick, so this runs on every change rather than once.
  useEffect(() => {
    if (nodes.length === 0 || !defaultsApplied) return;
    if (nodes.some((node) => node.id === nodeId && !ineligibility.get(node.id))) return;
    const firstEligible = nodes.find((node) => !ineligibility.get(node.id));
    setNodeId(firstEligible?.id ?? nodes[0]!.id);
  }, [defaultsApplied, ineligibility, nodeId, nodes]);

  const models = agentModels(nodes.find((node) => node.id === nodeId), agentKind);
  // Keep the choice valid for whichever machine and agent are selected now.
  useEffect(() => {
    if (!defaultsApplied || !nodesQuery.isFetched) return;
    const next = reconcileChoice(models, { ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    if ((next.model ?? "") !== model) setModel(next.model ?? "");
    if ((next.effort ?? "") !== effort) setEffort(next.effort ?? "");
  }, [defaultsApplied, effort, model, models, nodesQuery.isFetched]);

  const mutation = useMutation({
    // `force` only ever follows the tick: without conflicts it is left off, so
    // a dispatch that raced another one is refused instead of silently doubled.
    mutationFn: () => api.createDispatch({
      nodeId,
      agentKind,
      mode,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      itemKeys,
      ...(redispatchConfirmed ? { force: true } : {}),
    }),
    onSuccess: (dispatch) => {
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
        {created.sessionUrl && <SessionLink url={created.sessionUrl} />}
        {created.error && <div className="inline-error"><CirclePause size={16} /><span>{created.error}</span></div>}
        <p className="dispatch-note">{t("dispatchSessionPending")}</p>
        <p className="dispatch-note">{t("dispatchDoesNotClaim")}</p>
        <div className="form-footer">
          <button type="button" className="primary-button" onClick={onClose}>{t("close")}</button>
        </div>
      </div>
    );
  }

  const selectedReason = nodeId ? ineligibility.get(nodeId) ?? null : null;
  const modes = DISPATCH_MODES_BY_AGENT[agentKind];
  const modeHelp = dispatchModeHelpKey(agentKind, mode);
  const blocked = !nodeId || Boolean(selectedReason) || itemKeys.length === 0 || (conflicts.length > 0 && !redispatchConfirmed);

  return (
    <form
      className="dispatch-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked) mutation.mutate();
      }}
    >
      <div className="dispatch-items">
        <p className="eyebrow">{t("dispatchItemsLabel")}</p>
        <ul>
          {items.map((item) => (
            <li key={item.key}><code>{item.key}</code><span>{item.title}</span></li>
          ))}
        </ul>
      </div>

      {conflicts.length > 0 && (
        <div className="dispatch-conflict" role="alert">
          <p className="dispatch-conflict-heading"><TriangleAlert size={15} aria-hidden="true" /> {t("dispatchConflictHeading")}</p>
          <ul>
            {conflicts.map((entry) => {
              const statusKey = activeDispatchStatusKey(entry.status);
              return (
                <li key={entry.itemKey}>
                  {t("dispatchConflictLine", {
                    key: entry.itemKey,
                    node: entry.nodeName,
                    status: statusKey ? t(statusKey) : entry.status,
                    time: formatTime(entry.createdAt),
                  })}
                </li>
              );
            })}
          </ul>
          <p>{t("dispatchConflictExplain")}</p>
          {includesQueued(conflicts) && <p>{t("dispatchConflictQueuedCancelled")}</p>}
          <label className="dispatch-conflict-confirm">
            <input
              type="checkbox"
              checked={redispatchConfirmed}
              onChange={(event) => setAcknowledgedConflicts(event.target.checked ? conflictsKey : null)}
            />
            <span>{t("dispatchConflictConfirm")}</span>
          </label>
        </div>
      )}

      <label>{t("dispatchNode")}
        <select value={nodeId} onChange={(event) => setNodeId(event.target.value)} disabled={nodes.length === 0}>
          {nodes.map((node) => (
            <option key={node.id} value={node.id} disabled={Boolean(ineligibility.get(node.id))}>
              {nodeLabel(node)}
            </option>
          ))}
        </select>
      </label>
      {nodesQuery.isLoading && <p className="section-empty"><LoaderCircle className="spin" size={14} /></p>}
      {!nodesQuery.isLoading && nodes.length === 0 && <p className="section-empty">{t("dispatchNoNodes")}</p>}
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
          <select
            value={agentKind}
            onChange={(event) => {
              const next = event.target.value as AgentKind;
              const saved = defaultsQuery.data?.agents[next] ?? {};
              setAgentKind(next);
              // Each agent has its own modes; the one selected may not exist there.
              // Models are per agent too, so start from that agent's saved default.
              const preferred = saved.mode ?? mode;
              setMode(DISPATCH_MODES_BY_AGENT[next].includes(preferred) ? preferred : DISPATCH_MODES_BY_AGENT[next][0] ?? "");
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
          </select>
        </label>
        <label>{t("dispatchMode")}
          <select value={mode} onChange={(event) => setMode(event.target.value)}>
            {modes.map((value) => (
              <option key={value} value={value}>{modeLabel(agentKind, value)}</option>
            ))}
          </select>
        </label>
      </div>
      {modeHelp && <p className="dispatch-note">{t(modeHelp)}</p>}
      <div className="field-row">
        <label>{t("dispatchModel")}
          <select value={model} onChange={(event) => setModel(event.target.value)} disabled={!models}>
            <option value="">{t("dispatchModelLocal")}</option>
            {groupModelsByProvider(models ?? []).map((group) => (
              group.provider === null
                ? group.models.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.label}</option>
                ))
                : (
                  <optgroup key={group.provider} label={group.provider}>
                    {group.models.map((entry) => (
                      <option key={entry.id} value={entry.id}>{entry.label}</option>
                    ))}
                  </optgroup>
                )
            ))}
          </select>
        </label>
        <label>{t("dispatchEffort")}
          <select value={effort} onChange={(event) => setEffort(event.target.value)} disabled={!models}>
            <option value="">{t("dispatchModelLocal")}</option>
            {effortOptions(models, model || undefined).map((value) => (
              <option key={value} value={value}>{effortLabel(value)}</option>
            ))}
          </select>
        </label>
      </div>
      {nodeId && !models && nodesQuery.isFetched && <p className="dispatch-note">{t("dispatchModelUnsupported")}</p>}
      <p className="dispatch-note">{t("dispatchDoesNotClaim")}</p>

      {mutation.isError && (
        <div className="inline-error"><CirclePause size={16} /><span>{dispatchErrorMessage(mutation.error, t)}</span></div>
      )}

      <div className="form-footer">
        <button type="button" className="secondary-button" onClick={onClose}>{t("cancel")}</button>
        <button type="submit" className="primary-button" disabled={blocked || mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="spin" size={16} /> : <Rocket size={16} />}
          {t("dispatchSubmit")}
        </button>
      </div>
    </form>
  );
}
