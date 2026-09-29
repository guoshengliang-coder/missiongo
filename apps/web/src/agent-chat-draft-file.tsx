import { useEffect, useState } from "react";
import { FileText, Image as ImageIcon, Video, X } from "lucide-react";

import { useI18n } from "./i18n";

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
export function DraftChatFile({ file, disabled, onRemove }: { file: File; disabled: boolean; onRemove?: () => void }) {
  const { t } = useI18n();
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const imageFile = file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic)$/i.test(file.name);
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

  return <span className={`agent-chat-draft-file${mediaFile ? " agent-chat-draft-file-media" : ""}`} title={file.name}>
    <span className="agent-chat-draft-file-preview">
      {thumbnail && !imageFailed
        ? <img src={thumbnail} alt="" onError={() => setImageFailed(true)} />
        : imageFile ? <ImageIcon size={20} aria-hidden="true" />
        : videoFile ? <Video size={20} aria-hidden="true" />
        : <FileText size={20} aria-hidden="true" />}
    </span>
    {!mediaFile && <span className="agent-chat-draft-file-copy">
      <span className="agent-chat-draft-file-name">{file.name}</span>
      <small>{extension}</small>
    </span>}
    {onRemove && <button type="button" disabled={disabled} aria-label={t("agentChatRemoveFile", { filename: file.name })} onClick={onRemove}><X size={14} /></button>}
  </span>;
}
