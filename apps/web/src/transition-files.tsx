import { useRef, useState, type ClipboardEvent } from "react";
import { Plus } from "lucide-react";
import { DraftChatFile } from "./agent-chat-draft-file";
import { useFileDropZone } from "./file-drop";
import { FileDropOverlay } from "./file-drop-overlay";
import { useI18n } from "./i18n";
import { validateIncomingFiles } from "./incoming-files";
import { TransitionAttachmentAttempt } from "./transition-attachments";
import type { WorkItem } from "./types";

export function useTransitionFiles(items: readonly WorkItem[], disabled: boolean) {
  const { t } = useI18n();
  const [files, setFiles] = useState<readonly File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const attempt = useRef(new TransitionAttachmentAttempt()).current;
  const capacity = attempt.capacity(items, files);
  const remaining = Math.max(0, capacity - files.length);
  const addFiles = (incoming: readonly File[]) => {
    if (disabled) return;
    const result = validateIncomingFiles(files, incoming, t, capacity);
    setFiles(result.files); setFileError(result.error ?? null);
  };
  const { isDraggingFiles, dropHandlers } = useFileDropZone(addFiles, { canAccept: remaining > 0 && !disabled });
  return { files, fileError, attempt, remaining, addFiles, isDraggingFiles, dropHandlers,
    onPaste: (event: ClipboardEvent<HTMLElement>) => {
      const incoming = Array.from(event.clipboardData.files);
      if (incoming.length) { event.preventDefault(); addFiles(incoming); }
    },
    removeFile: (file: File) => { if (!disabled) { setFiles(current => current.filter(value => value !== file)); setFileError(null); } },
  };
}

export function TransitionFiles({ draft, disabled }: { draft: ReturnType<typeof useTransitionFiles>; disabled: boolean }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  return <div className="transition-files">
    {draft.isDraggingFiles && <FileDropOverlay remaining={draft.remaining} />}
    {draft.files.length > 0 && <div className="agent-chat-draft-files">
      {draft.files.map((file, index) => <DraftChatFile key={`${file.name}-${index}`} file={file} disabled={disabled} onRemove={() => draft.removeFile(file)} />)}
    </div>}
    <input ref={input} type="file" multiple hidden
      accept="image/png,image/jpeg,image/webp,image/gif,image/heic,video/mp4,video/quicktime,video/webm,.log,.md,.txt,.csv,.json,.pdf,.html,.zip"
      onChange={event => { draft.addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
    <button type="button" className="secondary-button" disabled={disabled || draft.remaining === 0} onClick={() => input.current?.click()}><Plus size={16} />{t("addAttachments")}</button>
    {draft.fileError && <p className="inline-error" role="alert">{draft.fileError}</p>}
    {draft.attempt.hasUploads && <p className="dispatch-note">{t("commentUploadRetained")}</p>}
  </div>;
}
