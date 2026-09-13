import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CirclePause, LoaderCircle, Rocket } from "lucide-react";

import { AGENT_KINDS, DISPATCH_MODES_BY_AGENT, type AgentKind } from "@missiongo/domain";

import { api, ApiError } from "./api";
import {
  NODE_INELIGIBILITY_KEYS,
  SUPPORTED_AGENT_KINDS,
  agentLabelKey,
  dispatchModeLabelKey,
  dispatchProblemKey,
  dispatchStatusLabelKey,
  nodeIneligibility,
  type NodeIneligibility,
} from "./dispatch-eligibility";
import { useI18n } from "./i18n";
import type { Dispatch, DispatchNode, Product, WorkItem } from "./types";

/**
 * The default mode. A dispatched session starts with nobody at the machine, so
 * it gets the one mode that stops and asks before it does anything.
 */
const DEFAULT_MODE = "plan";

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
  const { t } = useI18n();
  const [agentKind, setAgentKind] = useState<AgentKind>("claude_code");
  const [mode, setMode] = useState<string>(DEFAULT_MODE);
  const [nodeId, setNodeId] = useState("");
  // Held here rather than read back from the selection: dispatching clears the
  // selection, and the confirmation has to keep saying what was sent.
  const [created, setCreated] = useState<Dispatch | null>(null);

  const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes });
  const nodes = nodesQuery.data?.nodes ?? [];
  const itemKeys = useMemo(() => items.map((item) => item.key), [items]);
  const productIds = useMemo(() => [...new Set(items.map((item) => item.productId))], [items]);
  const ineligibility = useMemo(
    () => new Map(nodes.map((node) => [node.id, nodeIneligibility(node, { productIds, agentKind })])),
    [agentKind, nodes, productIds],
  );

  // Land on a machine that can actually take the batch. Changing the agent can
  // invalidate the current pick, so this runs on every change rather than once.
  useEffect(() => {
    if (nodes.length === 0) return;
    if (nodes.some((node) => node.id === nodeId && !ineligibility.get(node.id))) return;
    const firstEligible = nodes.find((node) => !ineligibility.get(node.id));
    setNodeId(firstEligible?.id ?? nodes[0]!.id);
  }, [ineligibility, nodeId, nodes]);

  const mutation = useMutation({
    mutationFn: () => api.createDispatch({ nodeId, agentKind, mode, itemKeys }),
    onSuccess: (dispatch) => {
      setCreated(dispatch);
      onDispatched(dispatch);
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
  const modeLabel = (value: string) => {
    const key = dispatchModeLabelKey(value);
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
          <span><small>{t("dispatchMode")}</small>{modeLabel(created.mode)}</span>
          <span><small>{t("status")}</small>{statusKey ? t(statusKey) : created.status}</span>
          <span><small>{t("dispatchItemsLabel")}</small>{created.itemKeys.join("、")}</span>
          {created.sessionName && <span><small>{t("dispatchSessionName")}</small>{created.sessionName}</span>}
        </div>
        {created.sessionUrl && (
          <p className="dispatch-session-link">
            <a href={created.sessionUrl} target="_blank" rel="noopener noreferrer">{t("dispatchOpenSession")}</a>
          </p>
        )}
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
  const blocked = !nodeId || Boolean(selectedReason) || itemKeys.length === 0;

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
              setAgentKind(next);
              // Each agent has its own modes; the one selected may not exist there.
              setMode(DISPATCH_MODES_BY_AGENT[next].includes(mode) ? mode : DISPATCH_MODES_BY_AGENT[next][0] ?? "");
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
              <option key={value} value={value}>{modeLabel(value)}</option>
            ))}
          </select>
        </label>
      </div>
      {mode === DEFAULT_MODE && <p className="dispatch-note">{t("dispatchPlanHelp")}</p>}
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
