import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CirclePause, ClipboardCheck, LoaderCircle, Plus, Trash2 } from "lucide-react";

import { api, ApiError } from "./api";
import { agentLabelKey } from "./dispatch-eligibility";
import { useI18n } from "./i18n";
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
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);
  // The plaintext code exists only here: the server keeps a hash, so leaving
  // this screen is what takes it away.
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);

  // Polled while this panel is open: online is a heartbeat away from changing,
  // and this is the screen somebody watches to see a machine come up after
  // running the pairing command.
  const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes, refetchInterval: 30_000 });
  const nodes = nodesQuery.data?.nodes ?? [];
  const pairingMutation = useMutation({
    mutationFn: () => api.createNodePairingCode({ name: name.trim() }),
    onSuccess: (created) => {
      setPairing(created);
      setCopied(false);
      setName("");
    },
  });

  const pairCommand = pairing ? `missiongo-node pair ${pairing.code} --server ${window.location.origin}` : "";

  return (
    <section className="product-settings-section" role="tabpanel">
      <header>
        <div><p className="eyebrow">{t("workspace")}</p><h3>{t("nodeSettings")}</h3></div>
        <div className="component-header-actions"><span>{nodes.filter((node) => node.online).length}</span></div>
      </header>
      <p className="component-management-help">{t("nodeSettingsHelp")}</p>
      <p className="component-management-help">{t("nodeSettingsScopeNote")}</p>
      <p className="node-requirements">{t("nodeRequirements")}</p>

      {pairing && (
        <div className="sdk-token-reveal">
          <p><Check size={15} /> {t("pairingCodeCreated")}</p>
          <div>
            <code>{pairCommand}</code>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                void navigator.clipboard.writeText(pairCommand);
                setCopied(true);
              }}
            >
              {copied ? <Check size={15} /> : <ClipboardCheck size={15} />} {copied ? t("copied") : t("copyToken")}
            </button>
          </div>
          <small>{t("pairingCodeExpires", { time: new Date(pairing.expiresAt).toLocaleString(locale) })}</small>
        </div>
      )}

      <div className="component-add-panel">
        <div className="component-add-row">
          <label>{t("nodeName")}
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("nodeNamePlaceholder")} maxLength={100} />
          </label>
          <button className="primary-button" disabled={!name.trim() || pairingMutation.isPending} onClick={() => pairingMutation.mutate()}>
            {pairingMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} {t("createPairingCode")}
          </button>
        </div>
      </div>
      {pairingMutation.isError && (
        <div className="inline-error"><CirclePause size={16} /><span>{nodeErrorMessage(pairingMutation.error, t("somethingWentWrong"))}</span></div>
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
    </section>
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
