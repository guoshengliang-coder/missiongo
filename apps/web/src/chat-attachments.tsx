import { useState } from "react";
import { Download, FileText, LoaderCircle, RotateCcw } from "lucide-react";
import { api } from "./api";
import { useI18n } from "./i18n";
import { MediaLightbox } from "./media-lightbox";
import { ZoomableImage } from "./zoomable-image";
import type { AgentSessionAttachment } from "./types";

/** A saved chat image keeps its footprint while the browser downloads and decodes it. */
function ChatImage({ sessionId, attachment, onImageLoad }: {
  sessionId: string; attachment: AgentSessionAttachment; onImageLoad?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const preview = api.agentSessionAttachmentPreviewUrl(sessionId, attachment.id);
  const src = attempt ? `${preview}?retry=${attempt}` : preview;
  const retry = () => { setState("loading"); setAttempt(value => value + 1); };
  const download = async () => {
    setDownloading(true);
    setDownloadError(false);
    try { await downloadChatAttachment(sessionId, attachment); }
    catch { setDownloadError(true); }
    finally { setDownloading(false); }
  };
  return <div className="agent-chat-image" data-image-state={state}>
    <button type="button" className="agent-chat-image-open" disabled={state !== "ready"}
      aria-label={t("previewAttachment", { filename: attachment.filename })} aria-busy={state === "loading"}
      onClick={() => setOpen(true)}>
      <img key={src} src={src} alt="" loading="lazy" decoding="async"
        onLoad={() => { setState("ready"); onImageLoad?.(); }} onError={() => setState("failed")} />
      {state === "loading" && <span className="agent-chat-image-loading" role="status">
        <LoaderCircle className="spin" size={18} aria-hidden="true" />{t("agentImageLoading")}
      </span>}
    </button>
    {state === "failed" && <div className="agent-chat-image-error" role="alert">
      <span>{t("attachmentFailed")}</span>
      <button type="button" className="secondary-button" onClick={retry}><RotateCcw size={16} />{t("retry")}</button>
    </div>}
    {open && <MediaLightbox title={attachment.filename} onClose={() => setOpen(false)} actions={
      <button type="button" disabled={downloading} onClick={() => void download()} aria-label={t("download")}>
        {downloading ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}
      </button>
    }>
      <ZoomableImage src={src} alt={attachment.filename} />
      {downloadError && <p className="agent-chat-image-download-error" role="alert">{t("attachmentFailed")}</p>}
    </MediaLightbox>}
  </div>;
}

async function downloadChatAttachment(sessionId: string, attachment: AgentSessionAttachment) {
  const response = await fetch(api.agentSessionAttachmentUrl(sessionId, attachment.id), { credentials: "same-origin" });
  if (!response.ok) throw new Error("Download failed");
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = attachment.filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function ChatAttachments({ sessionId, attachments, onImageLoad }: {
  sessionId: string; attachments: readonly AgentSessionAttachment[]; onImageLoad?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const [error, setError] = useState(false);
  return <div className="agent-chat-attachments">
    {attachments.map(attachment => {
      if (attachment.kind === "image") return <ChatImage key={`${sessionId}:${attachment.id}`} sessionId={sessionId} attachment={attachment} onImageLoad={onImageLoad} />;
      const src = api.agentSessionAttachmentUrl(sessionId, attachment.id);
      return <div className="agent-chat-attachment" key={attachment.id}>
        {attachment.kind === "video" ? <video controls preload="metadata" src={src} aria-label={attachment.filename} /> : <FileText size={17} />}
        <span title={attachment.filename}>{attachment.filename}</span>
        <a href={src} target="_blank" rel="noreferrer" aria-label={`${t("preview")} ${attachment.filename}`}><FileText size={16} /></a>
        <button type="button" onClick={() => { setError(false); void downloadChatAttachment(sessionId, attachment).catch(() => setError(true)); }} aria-label={`${t("download")} ${attachment.filename}`}><Download size={16} /></button>
      </div>;
    })}
    {error && <p className="inline-error" role="alert">{t("attachmentFailed")}</p>}
  </div>;
}
