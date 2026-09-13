import type { DispatchNode } from "./types";

/**
 * Where the guide puts the daemon. A fixed home-relative path rather than a
 * command on PATH: the machine has no package manager entry for it, and the
 * commands below have to work pasted into a fresh terminal as they are.
 */
const NODE_SCRIPT = "~/.missiongo-node/missiongo-node.mjs";

/** Served by this same deployment, next to the Skill download. */
export const NODE_DOWNLOAD_PATH = "/downloads/missiongo-node/missiongo-node.mjs";

// The origin is the page's own, which never ends in a slash; trimming anyway
// keeps a doubled slash out of a command somebody pastes into a shell.
function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

export const nodeCommands = {
  checkNode: "node --version",
  installNode: "brew install node",
  checkClaude: "claude auth status",
  loginClaude: "claude auth login",
  download: (origin: string) =>
    `mkdir -p ~/.missiongo-node && curl -fsSL ${trimOrigin(origin)}${NODE_DOWNLOAD_PATH} -o ${NODE_SCRIPT}`,
  pair: (origin: string, code: string) => `node ${NODE_SCRIPT} pair ${code} --server ${trimOrigin(origin)}`,
  installService: `node ${NODE_SCRIPT} install-service`,
  run: `node ${NODE_SCRIPT} run`,
} as const;

/**
 * What the panel knows about the machine somebody is connecting, judged only by
 * the node list.
 *
 * - `waiting`: no machine has turned up since the code was made.
 * - `paired`: a new machine redeemed a code but has not heartbeated yet -- the
 *   pairing step worked and the service step is what is left.
 * - `online`: a new machine is heartbeating; the guide has done its job.
 * - `expired`: nothing turned up and the code no longer works, so waiting on it
 *   would only keep the fast poll running for nothing.
 *
 * "New" means absent from the list taken before the code existed. Matching on
 * the name instead would call an old machine of the same name a success, and
 * matching on "any online machine" would do the same for every machine that was
 * already running.
 */
export type PairingProgress =
  | { readonly state: "waiting" }
  | { readonly state: "paired"; readonly node: DispatchNode }
  | { readonly state: "online"; readonly node: DispatchNode }
  | { readonly state: "expired" };

export function pairingProgress(
  pairing: { readonly baseline: readonly string[]; readonly expiresAt: string },
  nodes: readonly DispatchNode[],
  now: number,
): PairingProgress {
  const before = new Set(pairing.baseline);
  const arrived = nodes.filter((node) => !before.has(node.id) && !node.revokedAt);
  const online = arrived.find((node) => node.online);
  if (online) return { state: "online", node: online };
  // A redeemed code outlives its expiry for this purpose: the machine already
  // holds its credential, and installing the service can come much later.
  const paired = arrived[0];
  if (paired) return { state: "paired", node: paired };
  return Date.parse(pairing.expiresAt) <= now ? { state: "expired" } : { state: "waiting" };
}

/** The panel's usual poll, and the one used while somebody is watching a machine come up. */
export const NODE_LIST_REFETCH_MS = 30_000;
export const NODE_LIST_WAITING_REFETCH_MS = 5_000;

/**
 * Fast only while a machine is expected. A machine heartbeats within 30 seconds
 * of starting, so the usual poll could add another 30 on top of that to a screen
 * somebody is staring at; outside that window the fast poll is pure load.
 */
export function nodeListRefetchInterval(progress: PairingProgress | undefined): number {
  return progress?.state === "waiting" || progress?.state === "paired"
    ? NODE_LIST_WAITING_REFETCH_MS
    : NODE_LIST_REFETCH_MS;
}

/**
 * Put text on the clipboard, or report that it could not.
 *
 * The console also runs inside the Android WebView shell and over plain HTTP,
 * where `navigator.clipboard` is missing or rejects; the caller then selects the
 * text so it can still be copied by hand.
 */
export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
