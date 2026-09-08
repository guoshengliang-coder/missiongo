/**
 * The SDK collects diagnostics as structured entries, but they are a log file:
 * hundreds of lines that a person greps and an AI reads a page at a time. They
 * are stored as a `.log` attachment rather than inside the work item's creation
 * event, because an event payload has no paging and a 500-entry buffer inlined
 * into every read of the item is the single largest thing MissionGo returns.
 *
 * `.json` would have kept the structure for free, but the attachment rules file
 * a `.json` under documents on purpose -- a JSON attachment is far more often a
 * note than a log, and filing it under diagnostics buried it. So the structure
 * lives in the line format instead, and both sides of the wire use these two
 * functions so a writer and a reader cannot drift apart.
 */

export const FEEDBACK_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type FeedbackLogLevel = (typeof FEEDBACK_LOG_LEVELS)[number];

export interface FeedbackLogEntry {
  readonly timestamp: string;
  readonly level: FeedbackLogLevel;
  readonly message: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

/** Tabs separate the fields, so a message containing spaces needs no quoting. */
const SEPARATOR = "\t";

function singleLine(value: string): string {
  return value.replaceAll("\r\n", " ").replaceAll("\n", " ").replaceAll("\t", " ");
}

export function formatFeedbackLogLine(entry: FeedbackLogEntry): string {
  const attributes = entry.attributes && Object.keys(entry.attributes).length > 0
    ? SEPARATOR + singleLine(JSON.stringify(entry.attributes))
    : "";
  return entry.timestamp + SEPARATOR + entry.level.toUpperCase() + SEPARATOR + singleLine(entry.message) + attributes;
}

export function formatFeedbackLog(entries: readonly FeedbackLogEntry[]): string {
  return entries.map((entry) => formatFeedbackLogLine(entry)).join("\n") + (entries.length > 0 ? "\n" : "");
}

/**
 * Returns undefined for a line this format did not write. A log file can be
 * edited, truncated mid-line by paging, or replaced by hand, so an unreadable
 * line is expected rather than exceptional -- callers skip it and keep going.
 */
export function parseFeedbackLogLine(line: string): FeedbackLogEntry | undefined {
  const [timestamp, level, message, attributes] = line.split(SEPARATOR);
  if (!timestamp || !level || message === undefined) return undefined;
  const normalized = level.toLowerCase() as FeedbackLogLevel;
  if (!FEEDBACK_LOG_LEVELS.includes(normalized)) return undefined;
  if (Number.isNaN(Date.parse(timestamp))) return undefined;

  let parsed: Readonly<Record<string, string>> | undefined;
  if (attributes) {
    try {
      const value = JSON.parse(attributes) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
      }
    } catch {
      // A trailing field that is not the attribute object is dropped rather than
      // failing the line: the timestamp, level and message are still readable.
    }
  }
  return {
    timestamp,
    level: normalized,
    message,
    ...(parsed && Object.keys(parsed).length > 0 ? { attributes: parsed } : {}),
  };
}

export function parseFeedbackLog(text: string): readonly FeedbackLogEntry[] {
  return text.split("\n").flatMap((line) => {
    const entry = line.trim() ? parseFeedbackLogLine(line) : undefined;
    return entry ? [entry] : [];
  });
}
