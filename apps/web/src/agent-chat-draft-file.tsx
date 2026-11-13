import { useEffect, useRef, useState } from "react";
import { FileText, Highlighter, Image as ImageIcon, Video, X } from "lucide-react";

import { useI18n } from "./i18n";
import { MediaLightbox } from "./media-lightbox";
import { ZoomableImage } from "./zoomable-image";
import { ImageAnnotator } from "./lazy-image-annotator";
import { ImageAnnotationSaveError, isAnnotatableImage } from "./image-annotation";
import { validateAttachment } from "./attachment-validation";
import { useConfirm } from "./confirm-dialog";

/**
 * One file waiting to be sent, drawn above the reply box.
 *
 * A picture or a video is its own label: the thumbnail (or the video's first
 * frame) says more than its name, and a camera's long name was the only thing
 * stretching the draft row — so it is drawn alone, its name kept to the chip's
 * tooltip and the remove button's label. Every other file keeps a type icon,
 * the name behind an ellipsis, and its extension (AND-243).
 *
 * The first frame comes from the browser's own decoder — `onloadeddata` draws
 * it to a canvas. A codec the browser cannot read, or a picture it cannot
 * decode, keeps the type icon.
 */
export function DraftChatFile({ file, disabled, onRemove, onReplace }: {
  file: File; disabled: boolean; onRemove?: () => void;
  onReplace?: (original: File, annotated: File) => void;
}) {
  const { t } = useI18n();
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [editing, setEditing] = useState<File | null>(null);
  const closePreview = () => {
    setPreviewOpen(false);
    setEditing(null);
  };
  const confirm = useConfirm();
  const startingEdit = useRef(false);
  const mounted = useRef(false);
  const current = useRef({ file, disabled, onReplace });
  current.current = { file, disabled, onReplace };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const edit = async () => {
    if (disabled || !onReplace || startingEdit.current) return;
    startingEdit.current = true;
    try {
      if ((file.type === "image/gif" || /\.gif$/i.test(file.name))
        && !await confirm(t("agentImageGifWarning"), { title: t("annotateTitle"), confirmLabel: t("agentImageEdit"), danger: false })) return;
      if (!mounted.current || current.current.file !== file || current.current.disabled || !current.current.onReplace) return;
      setEditing(file);
    } finally { startingEdit.current = false; }
  };
  const save = (annotated: File) => {
    if (!mounted.current || !editing || current.current.file !== editing || current.current.disabled || !current.current.onReplace) {
      throw new ImageAnnotationSaveError(t("agentImageDraftChanged"));
    }
    const validation = validateAttachment(annotated, ["png", "jpg"]);
    if (!validation.valid) {
      throw new ImageAnnotationSaveError(validation.reason === "too-large"
        ? t("fileTooLarge", { filename: annotated.name, size: validation.limitMiB }) : t("annotateSaveFailed"));
    }
    current.current.onReplace(editing, annotated);
    setEditing(null);
  };
  const imageFile = file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic)$/i.test(file.name);
  const annotatable = isAnnotatableImage({ name: file.name, type: file.type || "image/unknown" });
  const videoFile = file.type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(file.name);
  const mediaFile = imageFile || videoFile;
  const extension = file.name.split(".").pop()?.toUpperCase() ?? "FILE";

  useEffect(() => {
    setThumbnail(null);
    setImageFailed(false);
    if (!imageFile && !videoFile) return;
    const url = URL.createObjectURL(file);
    if (imageFile) {
      setThumbnail(url);
      return () => URL.revokeObjectURL(url);
    }

    let active = true;
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.onloadeddata = () => {
      if (!active) return;
      try {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 144 / video.videoWidth, 90 / video.videoHeight);
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) return;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        setThumbnail(canvas.toDataURL("image/jpeg", 0.8));
      } catch {
        // Unsupported codecs and frame extraction errors keep the video icon.
      }
    };
    video.src = url;
    return () => {
      active = false;
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
  }, [file, imageFile, videoFile]);

  const thumbnailContent = <>
    {thumbnail && !imageFailed
      ? <img src={thumbnail} alt="" onError={() => setImageFailed(true)} />
      : imageFile ? <ImageIcon size={20} aria-hidden="true" />
      : videoFile ? <Video size={20} aria-hidden="true" />
      : <FileText size={20} aria-hidden="true" />}
  </>;

  return <>
    <span className={`agent-chat-draft-file${mediaFile ? " agent-chat-draft-file-media" : ""}`} title={file.name}>
      {imageFile ? <button type="button" className="agent-chat-draft-file-preview"
        aria-label={t("previewAttachment", { filename: file.name })} onClick={() => setPreviewOpen(true)}>
        {thumbnailContent}
      </button> : <span className="agent-chat-draft-file-preview">{thumbnailContent}</span>}
      {!mediaFile && <span className="agent-chat-draft-file-copy">
        <span className="agent-chat-draft-file-name">{file.name}</span>
        <small>{extension}</small>
      </span>}
      {onRemove && <button type="button" disabled={disabled} aria-label={t("agentChatRemoveFile", { filename: file.name })} onClick={onRemove}><X size={14} /></button>}
    </span>
    {previewOpen && imageFile && thumbnail && <MediaLightbox title={file.name} onClose={closePreview} actions={onReplace && <button
      type="button" disabled={disabled || imageFailed || !annotatable}
      aria-label={t("agentImageEdit")} title={t("agentImageEdit")} onClick={() => void edit()}><Highlighter size={20} /></button>}>
      {imageFailed ? <p className="agent-chat-draft-image-note" role="alert">{t(onReplace && !annotatable ? "annotateUnsupported" : "attachmentFailed")}</p> : <ZoomableImage src={thumbnail} alt={file.name} />}
      {onReplace && !annotatable && !imageFailed && <p className="agent-chat-draft-image-note" role="note">{t("annotateUnsupported")}</p>}
      {editing && <ImageAnnotator file={editing} saveHint={t("agentImageDraftHint")} onCancel={() => setEditing(null)} onSave={save} />}
    </MediaLightbox>}
  </>;
}
