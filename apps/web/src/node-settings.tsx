import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CirclePause, Download, LoaderCircle, Plus, Trash2 } from "lucide-react";

import { api, ApiError } from "./api";
import { agentLabelKey } from "./dispatch-eligibility";
import { useI18n } from "./i18n";
import {
  arrivalBaseline,
  arrivalProgress,
  MACOS_CLIENT_DOWNLOAD_PATH,
  NODE_WAIT_GIVE_UP_MS,
  nodeListRefetchInterval,
  type ArrivalProgress,
  type PendingArrival,
} from "./node-install";
import { draftDisplayName, MAX_NODE_NICKNAME_LENGTH, nicknameDraftChanged, parseNicknameDraft } from "./node-nickname";
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
 * Agent management (AND-51): the Macs that run dispatched work, the agents each
 * reported, and where every product's checkout lives on each of them.
 *
 * Account-level rather than tucked into one product's settings. A machine
 * belongs to the signed-in account and serves every product it can see, and the
 * repository table only reads right with those products side by side -- reached
 * through a product, it had to be configured once per product.
 */
export function NodeSettings({ products }: { products: readonly Product[] }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  // Set when the download is clicked. There is no code tying a Mac to this
  // screen any more -- the client signs in on its own -- so the node list from
  // that moment is the only way to tell which machine is the one being set up.
  const [arrival, setArrival] = useState<PendingArrival | null>(null);
  // Latched name of the machine that came up, so the confirmation survives the
  // wait ending rather than flickering away on the next refetch.
  const [arrived, setArrived] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  // Only a clock for the give-up: bumped once, when the wait runs out.
  const [now, setNow] = useState(() => Date.now());

  // Polled while this panel is open: online is a heartbeat away from changing,
  // and this is the screen somebody watches to see a Mac come up after signing
  // in. The interval is a function so it follows the wait that exists at each
  // fetch, and drops back once the wait is over.
  const nodesQuery = useQuery({
    queryKey: ["nodes"],
    queryFn: api.listNodes,
    refetchInterval: (query) => nodeListRefetchInterval(
      arrival ? arrivalProgress(arrival, query.state.data?.nodes ?? [], Date.now()) : undefined,
    ),
  });
  const nodes = nodesQuery.data?.nodes ?? [];
  const progress = arrival ? arrivalProgress(arrival, nodes, now) : undefined;
  const expecting = progress?.state === "waiting" || progress?.state === "signedIn";
  const arrivedNode = progress?.state === "online" ? progress.node : undefined;

  const startWaiting = () => {
    const startedAt = Date.now();
    // A second click while a wait is out keeps the first baseline: a Mac that
    // signed in after the first click is just as new. The clock restarts,
    // because the click says somebody is still at it.
    setArrival((current) => ({ baseline: current?.baseline ?? arrivalBaseline(nodes), startedAt }));
    setNow(startedAt);
    setArrived(null);
  };

  const startedAt = arrival?.startedAt;
  useEffect(() => {
    if (startedAt === undefined) return;
    const remaining = startedAt + NODE_WAIT_GIVE_UP_MS - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining + 250);
    return () => window.clearTimeout(timer);
  }, [startedAt]);

  const arrivedId = arrivedNode?.id;
  const arrivedName = arrivedNode?.name;
  useEffect(() => {
    if (!arrivedId || arrivedName === undefined) return;
    // The guide has done its job; the new machine's card is what matters now.
    setArrived(arrivedName);
    setArrival(null);
    setGuideOpen(false);
  }, [arrivedId, arrivedName]);

  // With no machine the guide is the whole point of the screen. With some, the
  // list is what people come back for, so the guide waits behind a button --
  // except while a Mac is on its way, when collapsing it would hide the status.
  const guideShown = nodes.length === 0 || guideOpen || Boolean(arrival);

  return (
    <section className="product-settings-section">
      <header>
        <div><h3>{t("nodeDevices")}</h3></div>
        <div className="component-header-actions"><span>{nodes.filter((node) => node.online).length}</span></div>
      </header>
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
          progress={progress}
          onDownload={startWaiting}
          onCollapse={nodes.length > 0 && !expecting
            ? () => {
              setGuideOpen(false);
              setArrival(null);
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

/**
 * From a bare Mac to a machine that stays online. Only what the browser has to
 * say: the client checks Claude Code and repository trust itself and explains
 * each gap there, where it can see them, so this page names them once and moves
 * on.
 */
function NodeInstallGuide({
  progress,
  onDownload,
  onCollapse,
}: {
  progress: ArrivalProgress | undefined;
  onDownload: () => void;
  onCollapse: (() => void) | undefined;
}) {
  const { t } = useI18n();

  return (
    <div className="node-install-guide">
      {/* A plain link rather than a fetch, like the Android download: the browser
          handles the save, and nothing here waits on it. The click only starts
          watching the list. */}
      <a className="primary-button node-download" href={MACOS_CLIENT_DOWNLOAD_PATH} download onClick={onDownload}>
        <Download size={15} /> {t("nodeDownloadMacClient")}
      </a>
      <p className="node-requirements">{t("nodeRequirements")}</p>
      <ol className="node-install-steps">
        <li>
          <h4>{t("nodeStepInstall")}</h4>
        </li>
        <li>
          <h4>{t("nodeStepOpen")}</h4>
          <p>{t("nodeStepOpenHelp")}</p>
        </li>
        <li>
          <h4>{t("nodeStepSignIn")}</h4>
          <p>{t("nodeStepSignInHelp")}</p>
        </li>
      </ol>

      {progress?.state === "waiting" && (
        <p className="node-pairing-status" role="status"><LoaderCircle className="spin" size={15} /> {t("nodeWaitingSignIn")}</p>
      )}
      {progress?.state === "signedIn" && (
        <p className="node-pairing-status" role="status">
          <LoaderCircle className="spin" size={15} /> {t("nodeSignedInWaiting", { name: progress.node.name })}
        </p>
      )}
      {progress?.state === "gaveUp" && (
        <p className="node-pairing-status" role="status"><CirclePause size={15} /> {t("nodeWaitGaveUp")}</p>
      )}
      {onCollapse && (
        <button type="button" className="text-button node-guide-collapse" onClick={onCollapse}>{t("nodeHideGuide")}</button>
      )}
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
  /**
   * The nickname as typed. It starts from the nickname rather than the display
   * name: showing the device name as the field's value would make it look like a
   * nickname somebody set, and saving it would pin the name the Mac reports.
   */
  const [nicknameDraft, setNicknameDraft] = useState(node.nickname ?? "");
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
  // Keyed on the nickname alone: it changes when somebody saves one here or in
  // the macOS client, not on every heartbeat, so a half-typed draft survives.
  useEffect(() => setNicknameDraft(node.nickname ?? ""), [node.nickname]);
  const parsedNickname = parseNicknameDraft(nicknameDraft);

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
  // the console cannot show is not a product somebody asked to unmap. (The
  // server leaves mappings for products this account cannot see alone anyway.)
  const paths: Readonly<Record<string, string>> = {
    ...saved,
    ...Object.fromEntries(rows.map((row) => [row.product.id, row.value])),
  };

  const nicknameMutation = useMutation({
    // Takes the value rather than reading the draft, so "use device name" can
    // clear the nickname without first emptying the field and waiting a render.
    mutationFn: (nickname: string | null) => api.setNodeNickname(node.id, nickname),
    onSuccess: async (_updated, nickname) => {
      setNicknameDraft(nickname ?? "");
      await onChanged();
    },
  });
  // Any key product works for the example; one of this account's reads as a
  // real session name rather than a placeholder.
  const exampleKeyPrefix = products.find((product) => !product.archivedAt)?.keyPrefix ?? products[0]?.keyPrefix;
  const exampleName = draftDisplayName(nicknameDraft, node);
  const sessionNameExample = exampleKeyPrefix ? `${exampleName}-${exampleKeyPrefix}-37` : exampleName;
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
        {/* No maxLength: the browser would silently cut a pasted name at the
            limit, where the message below says why it cannot be saved. */}
        <label className="node-name-field">{t("nodeNickname")}
          <input
            value={nicknameDraft}
            onChange={(event) => {
              setNicknameDraft(event.target.value);
              // A refusal is about the value that was sent; once it is edited,
              // the old message would describe something no longer on screen.
              if (nicknameMutation.isError) nicknameMutation.reset();
            }}
            placeholder={node.deviceName}
            disabled={Boolean(node.revokedAt)}
          />
        </label>
        <button
          type="button"
          className="secondary-button"
          disabled={!parsedNickname.ok || !nicknameDraftChanged(nicknameDraft, node) || nicknameMutation.isPending || Boolean(node.revokedAt)}
          onClick={() => {
            if (parsedNickname.ok) nicknameMutation.mutate(parsedNickname.nickname);
          }}
        >
          {nicknameMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("save")}
        </button>
        {node.nickname && !node.revokedAt && (
          <button
            type="button"
            className="secondary-button"
            disabled={nicknameMutation.isPending}
            onClick={() => nicknameMutation.mutate(null)}
          >
            {t("nodeRestoreDeviceName")}
          </button>
        )}
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
      <div className="node-nickname-notes">
        {node.nickname && <small>{t("nodeDeviceName", { name: node.deviceName })}</small>}
        {!node.revokedAt && <small>{t("nodeNicknameHelp", { example: sessionNameExample })}</small>}
        {/* Next to the field rather than with the card's other errors: the
            server's rules here are about what was just typed into it. */}
        {!parsedNickname.ok && (
          <div className="inline-error" role="alert">
            <CirclePause size={16} /><span>{t("nodeNicknameTooLong", { max: MAX_NODE_NICKNAME_LENGTH })}</span>
          </div>
        )}
        {nicknameMutation.error && (
          <div className="inline-error" role="alert">
            <CirclePause size={16} /><span>{nodeErrorMessage(nicknameMutation.error, t("somethingWentWrong"))}</span>
          </div>
        )}
      </div>
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
      {[revokeMutation.error, reposMutation.error].map((error, index) => error && (
        <div className="inline-error" key={index}><CirclePause size={16} /><span>{nodeErrorMessage(error, t("somethingWentWrong"))}</span></div>
      ))}
    </article>
  );
}

function repoPaths(node: DispatchNode): Readonly<Record<string, string>> {
  return Object.fromEntries(node.repos.map((repo) => [repo.productId, repo.repoPath]));
}
