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
