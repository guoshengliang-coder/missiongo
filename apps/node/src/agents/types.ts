/**
 * The seam between the dispatch loop and whichever coding agent runs the work.
 *
 * The loop only knows how to claim a dispatch, start something and report back;
 * everything that is specific to one agent — how it is detected, what argv it
 * takes, how a session URL shows up — belongs behind this interface. Codex and
 * Hermes adapters plug in here: add a module next to `claude-code.ts`, export
 * the same shape, and register it in the adapter list in `run.ts`. Nothing else
 * in the daemon should learn a new agent's name.
 */

// Mirrors AGENT_KINDS in packages/domain. The daemon is installed on a
// developer machine on its own and deliberately carries no workspace
// dependency, so the two lists are kept in step by hand.
export type AgentKind = "claude_code" | "codex" | "hermes";

/**
 * What the server hands over for one dispatch. Item keys, agent, mode and a
 * repository path — never a command line. What the session is actually told to
 * do is decided on this machine (see `prompt.ts`).
 */
export type DispatchJob = {
  dispatchId: string;
  itemKeys: readonly string[];
  repoPath: string;
  mode: string;
};

export type LaunchResult = {
  sessionName: string;
  /**
   * Absent when the session started but never printed its URL within the
   * launch window; the log is then the only way to find the session.
   */
  sessionUrl?: string;
  logPath: string;
};

export interface AgentAdapter {
  readonly kind: AgentKind;
  /** `undefined` when this agent is not installed on the machine. */
  detect(): Promise<{ version: string } | undefined>;
  /** Rejects with a human-readable reason; the loop reports it as the failure. */
  launch(job: DispatchJob): Promise<LaunchResult>;
}
