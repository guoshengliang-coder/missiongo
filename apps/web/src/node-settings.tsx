import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CirclePause, ClipboardCheck, LoaderCircle, Plus, Trash2 } from "lucide-react";

import { api, ApiError } from "./api";
import { agentLabelKey } from "./dispatch-eligibility";
import { useI18n } from "./i18n";
import { copyText, nodeCommands, nodeListRefetchInterval, pairingProgress, type PairingProgress } from "./node-install";
import { startsInManualMode, suggestRepoCandidate } from "./repo-match";
import type { DispatchNode, Product } from "./types";

function nodeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message || fallback;
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The one option in the repository select that is not a path. Candidate paths are
 * absolute, so this can never collide with a checkout the machine reported.
 */
const MANUAL_OPTION = "manual";

/**
 * Machines that run dispatched work: pairing, what each one reported, and where
 * each product's checkout lives on it.
 *
 * Account-wide rather than per-product, even though it is reached through a
 * product's settings, because a machine serves every product and the repository
 * table is only readable with all of them side by side -- a per-product view
 * would hide exactly the gap that makes a dispatch impossible.
 */
export function NodeSettings({ products }: { products: readonly Product[] }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  // The plaintext code exists only here: the server keeps a hash, so leaving
  // this screen is what takes it away. The baseline is the node list from just
  // before the code existed, which is how a machine that turns up is known to
  // be the one this code connected.
  const [pairing, setPairing] = useState<PendingPairing | null>(null);
  // Latched name of the machine that came up, so the confirmation survives the
  // wait ending rather than flickering away on the next refetch.
  const [arrived, setArrived] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  // Only a clock for the expiry: bumped once, when the code runs out.
  const [now, setNow] = useState(() => Date.now());

  // Polled while this panel is open: online is a heartbeat away from changing,
  // and this is the screen somebody watches to see a machine come up after
  // running the commands. The interval is a function so it follows the pairing
  // that exists at each fetch, and drops back once the wait is over.
  const nodesQuery = useQuery({
    queryKey: ["nodes"],
    queryFn: api.listNodes,
    refetchInterval: (query) => nodeListRefetchInterval(
      pairing ? pairingProgress(pairing, query.state.data?.nodes ?? [], Date.now()) : undefined,
    ),
  });
  const nodes = nodesQuery.data?.nodes ?? [];
  const progress = pairing ? pairingProgress(pairing, nodes, now) : undefined;
  const expecting = progress?.state === "waiting" || progress?.state === "paired";
  const arrivedNode = progress?.state === "online" ? progress.node : undefined;

  const pairingMutation = useMutation({
    mutationFn: async () => {
      // Read fresh, and before the code exists, so no machine that redeems this
      // code can already be in the baseline.
      const before = await queryClient.fetchQuery({ queryKey: ["nodes"], queryFn: api.listNodes, staleTime: 0 });
      const created = await api.createNodePairingCode({ name: name.trim() });
      return { ...created, baseline: before.nodes.map((node) => node.id) };
    },
    onSuccess: (created) => {
      // A second code while the first is still out keeps the first baseline: a
      // machine that took the first code is just as new as one taking this one.
      setPairing((current) => ({ code: created.code, expiresAt: created.expiresAt, baseline: current?.baseline ?? created.baseline }));
      setArrived(null);
      setName("");
    },
  });

  useEffect(() => {
    if (!pairing) return;
    const remaining = Date.parse(pairing.expiresAt) - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining + 250);
    return () => window.clearTimeout(timer);
  }, [pairing]);

  const arrivedId = arrivedNode?.id;
  const arrivedName = arrivedNode?.name;
  useEffect(() => {
    if (!arrivedId || arrivedName === undefined) return;
    // The guide has done its job; the new machine's card is what matters now.
    setArrived(arrivedName);
    setPairing(null);
    setGuideOpen(false);
  }, [arrivedId, arrivedName]);

  // With no machine the guide is the whole point of the screen. With some, the
  // list is what people come back for, so the guide waits behind a button --
  // except while a machine is on its way, when collapsing it would hide the code.
  const guideShown = nodes.length === 0 || guideOpen || Boolean(pairing);

  return (
    <section className="product-settings-section" role="tabpanel">
      <header>
        <div><p className="eyebrow">{t("workspace")}</p><h3>{t("nodeSettings")}</h3></div>
        <div className="component-header-actions"><span>{nodes.filter((node) => node.online).length}</span></div>
      </header>
      <p className="component-management-help">{t("nodeSettingsHelp")}</p>
      <p className="component-management-help">{t("nodeSettingsScopeNote")}</p>

      {arrived !== null && (
        <p className="node-pairing-status online" role="status"><Check size={15} /> {t("nodeCameOnline", { name: arrived })}</p>
      )}

      <div className="node-list">
        {!nodesQuery.isLoading && nodes.length === 0 && <p className="section-empty">{t("noNodes")}</p>}
        {nodesQuery.isError && (
          <div className="inline-error"><CirclePause size={16} /><span>{nodeErrorMessage(nodesQuery.error, t("somethingWentWrong"))}</span></div>
        )}
        {nodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            products={products}
            onChanged={() => queryClient.invalidateQueries({ queryKey: ["nodes"] })}
          />
        ))}
      </div>

      {/* Deciding collapsed-or-open before the list loads would open the guide and then snap it shut. */}
      {!nodesQuery.isLoading && (guideShown ? (
        <NodeInstallGuide
          origin={window.location.origin}
          pairing={pairing}
          progress={progress}
          creating={pairingMutation.isPending}
          createError={pairingMutation.isError ? nodeErrorMessage(pairingMutation.error, t("somethingWentWrong")) : null}
          name={name}
          onNameChange={setName}
          onCreate={() => pairingMutation.mutate()}
          onCollapse={nodes.length > 0 && !expecting
            ? () => {
              setGuideOpen(false);
              setPairing(null);
            }
            : undefined}
        />
      ) : (
        <button
          type="button"
          className="secondary-button node-add-another"
          onClick={() => {
            setArrived(null);
            setGuideOpen(true);
          }}
        >
          <Plus size={15} /> {t("nodeAddAnother")}
        </button>
      ))}
    </section>
  );
}

interface PendingPairing {
  readonly code: string;
  readonly expiresAt: string;
  readonly baseline: readonly string[];
}

/**
 * The steps from a bare Mac to a machine that stays online, in the order they
 * have to happen. Every command is shown whole, with the real origin and code in
 * it, because the person running it is usually on another screen and copying is
 * the only step that cannot be mistyped.
 */
function NodeInstallGuide({
  origin,
  pairing,
  progress,
  name,
  onNameChange,
  creating,
  createError,
  onCreate,
  onCollapse,
}: {
  origin: string;
  pairing: PendingPairing | null;
  progress: PairingProgress | undefined;
  name: string;
  onNameChange: (name: string) => void;
  creating: boolean;
  createError: string | null;
  onCreate: () => void;
  onCollapse: (() => void) | undefined;
}) {
  const { locale, t } = useI18n();
  const codeUsable = pairing !== null && progress?.state !== "expired";
  // The flag is literal JSON the check prints, so it is set as code rather than
  // translated along with the sentence around it.
  const [beforeFlag, afterFlag = ""] = t("nodePrereqClaude").split("{flag}");

  return (
    <div className="node-install-guide">
      <ol className="node-install-steps">
        <li>
          <h4>{t("nodeStepPrerequisites")}</h4>
          <p>{t("nodePrereqNode")}</p>
          <CommandBlock command={nodeCommands.checkNode} />
          <p>{t("nodePrereqNodeMissing")}</p>
          <CommandBlock command={nodeCommands.installNode} />
          <p>{beforeFlag}<code>"loggedIn": true</code>{afterFlag}</p>
          <CommandBlock command={nodeCommands.checkClaude} />
          <p>{t("nodePrereqClaudeMissing")}</p>
          <CommandBlock command={nodeCommands.loginClaude} />
          <p className="node-requirements">{t("nodeRequirements")}</p>
        </li>
        <li>
          <h4>{t("nodeStepDownload")}</h4>
          <p>{t("nodeStepDownloadHelp")}</p>
          <CommandBlock command={nodeCommands.download(origin)} />
        </li>
        <li>
          <h4>{t("nodeStepPair")}</h4>
          {codeUsable ? (
            <>
              <p>{t("pairingCodeCreated")}</p>
              {/* Keyed by code so a new code does not inherit the last one's "copied". */}
              <CommandBlock key={pairing.code} command={nodeCommands.pair(origin, pairing.code)} />
              <small>{t("pairingCodeExpires", { time: new Date(pairing.expiresAt).toLocaleString(locale) })}</small>
            </>
          ) : (
            <>
              <p>{t("nodeStepPairHelp")}</p>
              {progress?.state === "expired" && (
                <div className="inline-error"><CirclePause size={16} /><span>{t("pairingCodeExpired")}</span></div>
              )}
              <div className="node-pair-row">
                <label>{t("nodeName")}
                  <input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder={t("nodeNamePlaceholder")} maxLength={100} />
                </label>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!name.trim() || creating}
                  onClick={onCreate}
                >
                  {creating ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} {t("createPairingCode")}
                </button>
              </div>
            </>
          )}
          {createError && (
            <div className="inline-error"><CirclePause size={16} /><span>{createError}</span></div>
          )}
        </li>
        <li>
          <h4>{t("nodeStepService")}</h4>
          <p>{t("nodeStepServiceHelp")}</p>
          <CommandBlock command={nodeCommands.installService} />
          <p>{t("nodeStepServiceForeground")}</p>
          <CommandBlock command={nodeCommands.run} />
        </li>
      </ol>

      {progress?.state === "waiting" && (
        <p className="node-pairing-status" role="status"><LoaderCircle className="spin" size={15} /> {t("nodeWaitingOnline")}</p>
      )}
      {progress?.state === "paired" && (
        <p className="node-pairing-status" role="status">
          <LoaderCircle className="spin" size={15} /> {t("nodePairedWaiting", { name: progress.node.name })}
        </p>
      )}
      {onCollapse && (
        <button type="button" className="text-button node-guide-collapse" onClick={onCollapse}>{t("nodeHideGuide")}</button>
      )}
    </div>
  );
}

/**
 * A command as plain text with a copy button. Text children only: the pairing
 * code comes from the server, and nothing here should ever be parsed as markup.
 */
function CommandBlock({ command }: { command: string }) {
  const { t } = useI18n();
  const codeRef = useRef<HTMLElement>(null);
  const [feedback, setFeedback] = useState<"copied" | "selected" | null>(null);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 2_500);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const copy = async () => {
    if (await copyText(command, navigator.clipboard)) {
      setFeedback("copied");
      return;
    }
    // No clipboard (the Android WebView shell, plain HTTP): select the command so
    // the system's own copy is one tap away.
    const element = codeRef.current;
    const selection = window.getSelection();
    if (element && selection) selection.selectAllChildren(element);
    setFeedback("selected");
  };

  return (
    <div className="node-command">
      <code ref={codeRef}>{command}</code>
      <button type="button" className="secondary-button" onClick={() => void copy()}>
        {feedback === "copied" ? <Check size={14} /> : <ClipboardCheck size={14} />}
        {" "}{feedback === "copied" ? t("copied") : feedback === "selected" ? t("commandSelected") : t("copyCommand")}
      </button>
    </div>
  );
}

function NodeCard({
  node,
  products,
  onChanged,
}: {
  node: DispatchNode;
  products: readonly Product[];
  onChanged: () => void | Promise<unknown>;
}) {
  const { formatTime, t } = useI18n();
  const [name, setName] = useState(node.name);
  /**
   * Only the fields somebody has typed in. The machine heartbeats, so this list
   * is refetched while the form is open; holding every path in state meant each
   * heartbeat overwrote a half-typed path with the saved one.
   */
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  /**
   * Rows somebody switched between the reported list and a typed path. Unset
   * means the row still follows the machine's own report, so a machine that
   * starts reporting checkouts moves the untouched rows onto the list; like the
   * drafts, an explicit choice here has to outlive the refetch.
   */
  const [manual, setManual] = useState<Readonly<Record<string, boolean>>>({});
  const saved = repoPaths(node);
  const candidates = node.repoCandidates;
  const configured: Readonly<Record<string, string>> = { ...saved, ...drafts };
  useEffect(() => setName(node.name), [node.name]);

  const mappableProducts = products.filter((product) => !product.archivedAt || configured[product.id]);
  /**
   * One row each, with what it is showing.
   *
   * A suggestion goes only to a row with nothing configured: pre-selecting one
   * over a saved mapping, or over a path somebody is in the middle of typing,
   * would quietly change a mapping while claiming to help. It is also what save
   * would send, which is why the rows -- not the saved table -- are the source
   * of the payload: the form must save what it shows.
   */
  const rows = mappableProducts.map((product) => {
    const suggestion = configured[product.id] === undefined
      ? suggestRepoCandidate(product, candidates)
      : undefined;
    return {
      product,
      suggestion,
      value: configured[product.id] ?? suggestion?.path ?? "",
      manual: manual[product.id] ?? startsInManualMode(saved[product.id], candidates),
    };
  });
  // Saved rows whose product is not in this list keep their mapping: a product
  // the console cannot show is not a product somebody asked to unmap.
  const paths: Readonly<Record<string, string>> = {
    ...saved,
    ...Object.fromEntries(rows.map((row) => [row.product.id, row.value])),
  };

  const renameMutation = useMutation({
    mutationFn: () => api.renameNode(node.id, { name: name.trim() }),
    onSuccess: async () => { await onChanged(); },
  });
  const revokeMutation = useMutation({
    mutationFn: () => api.revokeNode(node.id),
    onSuccess: async () => { await onChanged(); },
  });
  const reposMutation = useMutation({
    // A product left blank is a product with no checkout here, which is a row
    // the server should not have rather than an empty one.
    mutationFn: () => api.setNodeRepos(
      node.id,
      Object.entries(paths)
        .filter(([, repoPath]) => repoPath.trim())
        .map(([productId, repoPath]) => ({ productId, repoPath: repoPath.trim() })),
    ),
    onSuccess: async () => {
      setDrafts({});
      setManual({});
      await onChanged();
    },
  });

  const state = node.revokedAt ? t("nodeRevoked") : node.online ? t("nodeOnline") : t("nodeOffline");

  return (
    <article className={`node-card ${node.revokedAt ? "revoked" : ""}`}>
      <header>
        <label className="node-name-field">{t("nodeName")}
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} disabled={Boolean(node.revokedAt)} />
        </label>
        <button
          type="button"
          className="secondary-button"
          disabled={!name.trim() || name.trim() === node.name || renameMutation.isPending || Boolean(node.revokedAt)}
          onClick={() => renameMutation.mutate()}
        >
          {renameMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("save")}
        </button>
        {!node.revokedAt && (
          <button
            type="button"
            className="secondary-button sdk-token-revoke"
            disabled={revokeMutation.isPending}
            onClick={() => {
              if (window.confirm(t("confirmRevokeNode", { name: node.name }))) revokeMutation.mutate();
            }}
          >
            <Trash2 size={14} /> {t("revoke")}
          </button>
        )}
      </header>
      <div className="node-facts">
        <span className={`status-pill ${node.revokedAt ? "status-cancelled" : node.online ? "status-ready" : "status-inbox"}`}>{state}</span>
        <small>{node.lastSeenAt ? t("nodeLastSeen", { time: formatTime(node.lastSeenAt) }) : t("nodeNeverSeen")}</small>
        {node.hostname && <small>{t("nodeHostname")}: <code>{node.hostname}</code></small>}
      </div>
      <div className="node-facts">
        <small>{t("nodeAgents")}:</small>
        {node.agents.length === 0 && <small>{t("nodeNoAgents")}</small>}
        {node.agents.map((agent) => {
          const key = agentLabelKey(agent.kind);
          return (
            <small key={agent.kind} className="node-agent">
              {key ? t(key) : agent.kind}{agent.version ? ` ${agent.version}` : ""}
            </small>
          );
        })}
      </div>

      <div className="node-repos">
        <strong>{t("nodeRepos")}</strong>
        <small>{t("nodeReposHelp")}</small>
        {candidates.length === 0 && <small>{t("nodeNoRepoCandidates")}</small>}
        {rows.map(({ product, suggestion, value, manual: isManual }) => (
          <label key={product.id} className="node-repo-row">
            <span>{product.name} <code>{product.keyPrefix}</code></span>
            <div className="node-repo-choice">
              {candidates.length > 0 && (
                <select
                  value={isManual ? MANUAL_OPTION : value}
                  disabled={Boolean(node.revokedAt)}
                  onChange={(event) => {
                    const next = event.target.value;
                    setManual({ ...manual, [product.id]: next === MANUAL_OPTION });
                    // Switching to manual keeps the path on screen as the text to
                    // edit, and makes it an explicit edit: from here on it is
                    // this person's path rather than the list's or a suggestion.
                    setDrafts({ ...drafts, [product.id]: next === MANUAL_OPTION ? value : next });
                  }}
                >
                  <option value="">{t("repoNotMapped")}</option>
                  {candidates.map((candidate) => (
                    <option key={candidate.path} value={candidate.path}>
                      {t(candidate.path === suggestion?.path ? "repoSuggestedOption" : "repoCandidateOption", {
                        name: candidate.name,
                        path: candidate.path,
                      })}
                    </option>
                  ))}
                  <option value={MANUAL_OPTION}>{t("repoEnterManually")}</option>
                </select>
              )}
              {isManual && (
                <input
                  value={value}
                  onChange={(event) => setDrafts({ ...drafts, [product.id]: event.target.value })}
                  placeholder={t("repoPathPlaceholder")}
                  spellCheck={false}
                  // The row's own label belongs to the select when there is one,
                  // so the path field has to name itself.
                  aria-label={candidates.length > 0 ? t("repoPathManualLabel", { product: product.name }) : undefined}
                  disabled={Boolean(node.revokedAt)}
                />
              )}
              {suggestion && <small>{t("repoSuggestedHint")}</small>}
            </div>
          </label>
        ))}
        <button
          type="button"
          className="primary-button"
          disabled={reposMutation.isPending || Boolean(node.revokedAt)}
          onClick={() => reposMutation.mutate()}
        >
          {reposMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("saveRepoPaths")}
        </button>
      </div>

      {/* The absolute-path rule is the server's, so its wording is the server's too. */}
      {[renameMutation.error, revokeMutation.error, reposMutation.error].map((error, index) => error && (
        <div className="inline-error" key={index}><CirclePause size={16} /><span>{nodeErrorMessage(error, t("somethingWentWrong"))}</span></div>
      ))}
    </article>
  );
}

function repoPaths(node: DispatchNode): Readonly<Record<string, string>> {
  return Object.fromEntries(node.repos.map((repo) => [repo.productId, repo.repoPath]));
}
