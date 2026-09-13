import type { WorkItemEvent } from "./types";

export interface TimelineEntry {
  readonly id: string;
  readonly event: WorkItemEvent;
  readonly count: number;
  readonly filenames: readonly string[];
}

const MERGEABLE_EVENTS = new Set(["attachment_added", "attachment_removed", "attachment_replaced"]);

function eventFilename(event: WorkItemEvent): string | undefined {
  const filename = event.payload.filename;
  return typeof filename === "string" ? filename : undefined;
}

/**
 * Newest first, with a run of attachment events by the same actor folded into
 * one entry. Uploading four files used to write four identical "attachment
 * added" lines carrying no filename, which buried the status changes that
 * actually move an item along.
 */
export function groupTimeline(events: readonly WorkItemEvent[]): readonly TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const event of [...events].reverse()) {
    const previous = entries.at(-1);
    const mergeable = MERGEABLE_EVENTS.has(event.eventType)
      && previous?.event.eventType === event.eventType
      && previous.event.actorKind === event.actorKind;
    if (mergeable && previous) {
      const filename = eventFilename(event);
      entries[entries.length - 1] = {
        ...previous,
        count: previous.count + 1,
        filenames: filename ? [...previous.filenames, filename] : previous.filenames,
      };
      continue;
    }
    const filename = eventFilename(event);
    entries.push({ id: event.id, event, count: 1, filenames: filename ? [filename] : [] });
  }
  return entries;
}

export interface DispatchedEvent {
  readonly nodeName: string;
  readonly agentKind: string;
  readonly mode: string;
  readonly itemKeys: readonly string[];
}

/**
 * What a `dispatched` event can say for itself.
 *
 * The line has to answer "where did this go", so a payload without a machine
 * name has nothing to add and the timeline falls back to the plain event label.
 * Every field is checked rather than cast: a payload is stored JSON, and one
 * written by an older build -- or by a newer one -- must not take the pane down.
 */
export function dispatchedEvent(payload: Readonly<Record<string, unknown>>): DispatchedEvent | null {
  const nodeName = typeof payload.nodeName === "string" ? payload.nodeName.trim() : "";
  if (!nodeName) return null;
  return {
    nodeName,
    agentKind: typeof payload.agentKind === "string" ? payload.agentKind : "",
    mode: typeof payload.mode === "string" ? payload.mode : "",
    itemKeys: Array.isArray(payload.itemKeys)
      ? payload.itemKeys.filter((key): key is string => typeof key === "string")
      : [],
  };
}
