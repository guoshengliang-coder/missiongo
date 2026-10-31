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

/** Imported histories can reuse IDs; ownership never crosses an item or source. */
function eventKey(event: WorkItemEvent, id: string): string {
  return JSON.stringify([event.itemKey, event.historySourceKey ?? null, id]);
}

/**
 * Keep the immutable events, but present uploads under their explicit operation.
 * Comments already carry attachment IDs, including old comments. Creation needs
 * a server-validated link; proximity in time is never evidence of ownership.
 */
export function groupTimeline(events: readonly WorkItemEvent[]): readonly TimelineEntry[] {
  const creations = new Map(events.filter(event => event.eventType === "item_created")
    .map(event => [eventKey(event, event.id), event]));
  const commentFiles = new Set<string>();
  for (const event of events) {
    if (event.eventType !== "comment_added" || event.payload.bodyKind !== "free") continue;
    const body = event.payload.body;
    if (!body || typeof body !== "object" || !("attachmentIds" in body) || !Array.isArray(body.attachmentIds)) continue;
    for (const id of body.attachmentIds) if (typeof id === "string") commentFiles.add(eventKey(event, id));
  }
  const absorbed = new Set<string>();
  const creationFiles = new Map<string, string[]>();
  for (const event of events) {
    if (event.eventType !== "attachment_added") continue;
    const creationId = event.payload.creationEventId;
    const creationKey = typeof creationId === "string" ? eventKey(event, creationId) : undefined;
    if (creationKey && creations.has(creationKey)) {
      absorbed.add(eventKey(event, event.id));
      const filename = eventFilename(event);
      if (filename) creationFiles.set(creationKey, [...(creationFiles.get(creationKey) ?? []), filename]);
    } else if (typeof event.payload.attachmentId === "string" && commentFiles.has(eventKey(event, event.payload.attachmentId))) {
      absorbed.add(eventKey(event, event.id));
    }
  }

  const entries: TimelineEntry[] = [];
  for (const event of [...events].reverse()) {
    if (absorbed.has(eventKey(event, event.id))) continue;
    const previous = entries.at(-1);
    const mergeable = MERGEABLE_EVENTS.has(event.eventType)
      && previous?.event.eventType === event.eventType
      && previous.event.itemKey === event.itemKey
      && previous.event.actorKind === event.actorKind
      && previous.event.accountId === event.accountId
      && previous.event.clientId === event.clientId
      && previous.event.executionId === event.executionId
      && previous.event.historySourceKey === event.historySourceKey;
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
    entries.push({ id: event.id, event, count: 1,
      filenames: creationFiles.get(eventKey(event, event.id)) ?? (filename ? [filename] : []) });
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

/**
 * What a person typed when they moved the item.
 *
 * Sending work back to Ready has to carry one, which is the case this exists
 * for; handing merged work over carries the agent's summary in the same field,
 * and that is worth showing too. Older events have nothing here and render as
 * they always did.
 */
export function statusChangeNote(payload: Readonly<Record<string, unknown>>): string | null {
  const note = typeof payload.note === "string" ? payload.note.trim() : "";
  return note || null;
}

/** Replies retain their immediate parent, but render once under the root in creation order. */
export function groupDiscussionTimeline(events: readonly WorkItemEvent[]): readonly (TimelineEntry & {replies:readonly WorkItemEvent[]})[] {
  const comments=new Map(events.filter(event=>event.eventType==="comment_added").map(event=>[event.id,event]));
  const groups=new Map<string,WorkItemEvent[]>();
  const childIds=new Set<string>();
  for(const event of comments.values()) {
    const root=event.payload.threadRootCommentId;
    if(typeof root!=="string" || root===event.id || !comments.has(root))continue;
    const replies=groups.get(root) ?? [];replies.push(event);groups.set(root,replies);childIds.add(event.id);
  }
  return groupTimeline(events).filter(entry=>!childIds.has(entry.id)).map(entry=>({...entry,replies:groups.get(entry.id) ?? []}));
}

/** Activity order applies only to discussions; the complete audit trail keeps its original order. */
export function recentDiscussions(events:readonly WorkItemEvent[]) {
  return groupDiscussionTimeline(events).filter(entry=>entry.event.eventType==="comment_added")
    .sort((a,b)=>discussionActivity(b).localeCompare(discussionActivity(a)));
}

export function discussionActivity(entry:TimelineEntry & {replies:readonly WorkItemEvent[]}):string {
  return entry.replies.reduce((latest,reply)=>reply.createdAt>latest?reply.createdAt:latest,entry.event.createdAt);
}
