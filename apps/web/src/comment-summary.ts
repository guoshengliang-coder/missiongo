import type { ActorKind } from "./types";

/**
 * How a comment is signed.
 *
 * Two sources, deliberately kept apart until the last moment. `clientName` is
 * decoded server-side from the signed OAuth client id, so it is the program
 * that actually holds the token and cannot be faked. `agentName` is whatever
 * the agent typed, which is the only way to learn *which machine* it was
 * running on -- nothing in the system knows that otherwise.
 */
export function commentAuthor(
  entry: {
    readonly actorKind: ActorKind;
    readonly clientName?: string | undefined;
    readonly agentName?: string | undefined;
  },
  actorLabel: string,
): string {
  if (entry.actorKind !== "agent") return actorLabel;
  const agentName = entry.agentName?.trim();
  const clientName = entry.clientName?.trim();
  if (agentName && clientName) {
    // Agents are asked to send "Claude Code · studio-mac", which already leads
    // with the client name. Printing it twice reads like a stutter.
    return agentName.toLowerCase().includes(clientName.toLowerCase()) ? agentName : `${clientName} · ${agentName}`;
  }
  return agentName || clientName || actorLabel;
}

/**
 * The agent name off a timeline event.
 *
 * It travels inside the comment's payload rather than on the event, because
 * only comments have one -- a status change has no agent name to report.
 */
export function eventAgentName(payload: Readonly<Record<string, unknown>>): string | undefined {
  const name = typeof payload.agentName === "string" ? payload.agentName.trim() : "";
  return name || undefined;
}

/** Past this a comment is worth folding away behind its summary. */
export const COMMENT_COLLAPSE_THRESHOLD = 320;

const SENTENCE_END = /[。！？!?.\n]/u;

/**
 * A one-line stand-in for a comment that did not bring its own summary.
 *
 * Every comment written before summaries existed is in this position, and so is
 * anything a person types into the comment box, so the fallback has to be
 * decent rather than a courtesy. The first sentence is the honest choice: it is
 * the writer's own words, not a guess at what they meant.
 */
export function deriveSummary(text: string, limit = 120): string {
  const source = text.trim();
  if (!source) return "";
  // The boundary is found before the whitespace is flattened, so a line break
  // still ends a sentence: people write the point on the first line and the
  // detail underneath, and flattening first would swallow that.
  const match = SENTENCE_END.exec(source);
  const sentence = match && match.index > 0 ? source.slice(0, match.index + 1) : source;
  const flat = sentence.replaceAll(/\s+/gu, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit).trimEnd()}…`;
}

/** The comment's readable text, used for both the length test and the fallback summary. */
export function commentPlainText(bodyKind: unknown, body: Readonly<Record<string, unknown>>): string {
  const str = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : "");
  const list = (key: string) => (Array.isArray(body[key])
    ? (body[key] as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : []);
  if (bodyKind !== "structured") return str("text");
  // Finding first: it is what the analysis concluded, and so the most useful
  // thing to show when only one line fits.
  return [str("finding"), str("understanding"), str("proposal"), ...list("evidence"), ...list("openQuestions")]
    .filter(Boolean)
    .join(" ");
}
