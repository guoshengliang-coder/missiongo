import { errorMessageKey } from "./error-text";
import type { MessageKey } from "./i18n";
import { api } from "./api";
import type { TransitionAction, WorkItem, WorkItemStatus } from "./types";

/** One dialog owns the upload receipts and write keys, including lost-response retries. */
export class TransitionAttachmentAttempt {
  private readonly uploads = new Map<string, Map<File, { key: string; id?: string }>>();
  private readonly attempts = new Map<string, { fingerprint: string; key: string; expectedStatus: WorkItemStatus }>();
  readonly confirmed = new Map<string, WorkItem>();

  capacity(items: readonly WorkItem[], files: readonly File[]): number {
    return Math.max(0, Math.min(...items.map(item => {
      const counted = new Set(item.attachments.map(file => file.id));
      const uploads = this.uploads.get(item.key);
      const selected = files.filter(file => counted.has(uploads?.get(file)?.id ?? "")).length;
      // A partial upload can precede a refreshed item snapshot.
      const uncounted = [...(uploads?.values() ?? [])].filter(upload => upload.id && !counted.has(upload.id)).length;
      return 10 - item.attachments.length - uncounted + selected
        + files.filter(file => { const id = uploads?.get(file)?.id; return id && !counted.has(id); }).length;
    })));
  }

  get hasUploads(): boolean {
    return [...this.uploads.values()].some(files => [...files.values()].some(file => file.id));
  }

  async submit(itemKey: string, from: WorkItemStatus, action: TransitionAction, note: string, files: readonly File[]): Promise<WorkItem> {
    const confirmed = this.confirmed.get(itemKey);
    if (confirmed) return confirmed;
    let uploads = this.uploads.get(itemKey);
    if (!uploads) { uploads = new Map(); this.uploads.set(itemKey, uploads); }
    const attachmentIds: string[] = [];
    for (const file of files) {
      let upload = uploads.get(file);
      if (!upload) { upload = { key: crypto.randomUUID() }; uploads.set(file, upload); }
      if (!upload.id) upload.id = (await api.uploadAttachment(itemKey, file, upload.key)).id;
      attachmentIds.push(upload.id);
    }
    const fingerprint = JSON.stringify([action.to, action.reason, note.trim(), attachmentIds]);
    let attempt = this.attempts.get(itemKey);
    if (attempt?.fingerprint !== fingerprint) { attempt = { fingerprint, key: crypto.randomUUID(), expectedStatus: from }; this.attempts.set(itemKey, attempt); }
    const result = await api.transitionItem(itemKey, action, note, { attachmentIds, idempotencyKey: attempt!.key, expectedStatus: attempt!.expectedStatus });
    this.confirmed.set(itemKey, result);
    return result;
  }
}

export function transitionErrorText(error: unknown, t: (key: MessageKey) => string): string {
  return t(errorMessageKey(error) ?? "transitionSubmitFailed");
}
