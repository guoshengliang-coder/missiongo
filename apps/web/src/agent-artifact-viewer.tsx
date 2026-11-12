import { OverlayDialog } from "./overlay";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, LoaderCircle, RotateCcw, X } from "lucide-react";
import { localArtifactLinks, localArtifactImageLinks, localArtifactPath, artifactResourceName, type AgentArtifactBundle } from "@missiongo/domain";
import { createPortal } from "react-dom";

import { ZoomableImage } from "./zoomable-image";
import { artifactGalleryLinks } from "./agent-artifact-gallery";

import { api } from "./api";
import { useI18n, type MessageKey } from "./i18n";
import { MarkdownText } from "./markdown-text";
import { artifactDataUrl, artifactHtml, artifactText } from "./agent-artifact-preview";

const errorKeys: Record<string, MessageKey> = {
  node_unavailable: "artifactNodeUnavailable", file_missing: "artifactFileMissing", unsupported: "artifactUnsupported",
  reference_missing: "artifactReferenceMissing", file_denied: "artifactFileDenied", too_large: "artifactTooLarge", resource_missing: "artifactResourceMissing",
};

export function AgentArtifactMarkdown({ text, sessionId, messageId, onImageLoad }: { text: string; sessionId: string; messageId: string; onImageLoad?: (() => void) | undefined }) {
  const [selection, setSelection] = useState<{ sessionId: string; messageId: string; href: string; links: string[] }>();
  const closeViewer = useCallback(() => setSelection(undefined), []);
  useEffect(closeViewer, [sessionId, messageId, closeViewer]);
  const openViewer = useCallback((value: string) => {
    const href = localArtifactLinks(text).find(link => localArtifactPath(link) === localArtifactPath(value)) ?? value;
    const gallery = artifactGalleryLinks(text);
    setSelection({ sessionId, messageId, href, links: gallery.includes(href) ? gallery : [href] });
  }, [text, sessionId, messageId]);
  const images = useMemo(() => localArtifactImageLinks(text), [text]);
  return <>
    <MarkdownText onLocalArtifactOpen={openViewer} hideLocalImages>{text}</MarkdownText>
    {images.length > 0 && <div className="agent-output-images">{images.map((image) =>
      <ArtifactImage key={`${sessionId}:${messageId}:${image}`} sessionId={sessionId} messageId={messageId} href={image} onOpen={() => openViewer(image)} onLoad={onImageLoad} />)}</div>}
    {selection?.sessionId === sessionId && selection.messageId === messageId && createPortal(<ArtifactViewer key={`${sessionId}:${messageId}`} sessionId={sessionId} messageId={messageId} initialHref={selection.href} links={selection.links} onClose={closeViewer} />, document.body)}
  </>;
}

/** Shared request/cache for inline thumbnails and the full-size viewer. No raw file URL reaches the browser. */
function useArtifact(sessionId: string, messageId: string, href: string) {
  const [waiting, setWaiting] = useState(false);
  const request = useQuery({ queryKey: ["artifact-request", sessionId, messageId, href], queryFn: () => api.requestAgentArtifact(sessionId, messageId, href), retry: false, staleTime: Infinity });
  const state = useQuery({ queryKey: ["artifact-state", sessionId, request.data?.id], queryFn: () => api.agentArtifact(sessionId, request.data!.id), enabled: Boolean(request.data) });
  const status = state.data && state.dataUpdatedAt >= request.dataUpdatedAt ? state.data : request.data;
  const bundle = useQuery({ queryKey: ["artifact-bundle", sessionId, status?.id], queryFn: () => api.agentArtifactBundle(sessionId, status!.id), enabled: status?.status === "ready", staleTime: Infinity });
  useEffect(() => {
    setWaiting(false);
    const timer = setTimeout(() => setWaiting(true), 20_000);
    return () => clearTimeout(timer);
  }, [request.dataUpdatedAt]);
  const retry = async () => {
    await request.refetch();
    await state.refetch();
    if (status?.status === "ready") await bundle.refetch();
  };
  return { request, state, bundle, status, waiting, retry };
}

function ArtifactImage({ sessionId, messageId, href, onOpen, onLoad }: {
  sessionId: string; messageId: string; href: string; onOpen: () => void; onLoad?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const { request, state, bundle, status, waiting, retry } = useArtifact(sessionId, messageId, href);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const entry = bundle.data?.files.find((file) => file.name === bundle.data?.entry);
  const url = useMemo(() => entry?.contentType.startsWith("image/") ? artifactDataUrl(entry) : undefined, [entry]);
  const failed = request.isError || state.isError || bundle.isError || status?.status === "failed" || decodeFailed || Boolean(entry && !url);
  return <div className="agent-output-image">
    {failed ? <div className="agent-output-image-state" role="alert"><span>{t(errorKeys[status?.error ?? ""] ?? "agentImageUnavailable")}</span>{status?.errorResource && artifactResourceName(status.errorResource) && <span>{t("artifactProblemResource", { name: status.errorResource })}</span>}
      <button type="button" className="artifact-link" onClick={() => { setDecodeFailed(false); void retry(); }}>{t("retry")}</button></div>
      : url ? <button type="button" className="agent-output-image-open" aria-label={t("agentImagePreview")} onClick={onOpen}>
        <img src={url} alt={t("agentImagePreview")} onLoad={onLoad} onError={() => setDecodeFailed(true)} />
      </button> : <div className="agent-output-image-state" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />
        <span>{t(waiting ? "artifactWaiting" : "agentImageLoading")}</span>
        {waiting && <button type="button" className="artifact-link" onClick={() => void retry()}>{t("retry")}</button>}
      </div>}
  </div>;
}

function ArtifactViewer({ sessionId, messageId, initialHref, links, onClose }: {
  sessionId: string; messageId: string; initialHref: string; links: string[]; onClose: () => void;
}) {
  const { t } = useI18n();
  const [index, setIndex] = useState(() => Math.max(0, links.indexOf(initialHref)));
  const navigation = useRef<HTMLElement>(null);
  const navigate = (direction: "previous" | "next") => {
    // A focused button becoming disabled can blur to the inert background.
    // Keep keyboard navigation in this stable layer when reaching an edge.
    if (navigation.current?.contains(document.activeElement)
      && (direction === "previous" ? index <= 1 : index >= links.length - 2)) navigation.current.focus({ preventScroll: true });
    setIndex(current => Math.max(0, Math.min(links.length - 1, current + (direction === "previous" ? -1 : 1))));
  };
  return <OverlayDialog className="artifact-backdrop" onClose={onClose} aria-label={t("artifactPreview")}
    onKeyDown={event => {
      if (links.length < 2 || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || !(event.target instanceof Element) || event.target.closest('input, textarea, select, video, iframe, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="combobox"]')) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        navigate(event.key === "ArrowLeft" ? "previous" : "next");
      }
    }}>
    <div className="artifact-viewer">
      <header><strong tabIndex={0}>{localArtifactPath(links[index]!)?.split("/").at(-1) ?? t("artifactPreview")}</strong><button className="icon-button" type="button" onClick={onClose} aria-label={t("close")}><X size={20} /></button></header>
      <ArtifactSlide key={links[index]} sessionId={sessionId} messageId={messageId} href={links[index]!} onNavigate={navigate} />
      {links.length > 1 && <footer ref={navigation} tabIndex={-1} className="artifact-navigation" aria-label={t("artifactNavigation")}>
        <button className="secondary-button" type="button" disabled={index === 0} onClick={() => navigate("previous")} aria-label={t("previousMedia")}><ChevronLeft size={20} /></button>
        <div aria-live="polite" aria-atomic="true"><strong>{index + 1} / {links.length}</strong><span>{t("artifactMessageOnly")}</span></div>
        <button className="secondary-button" type="button" disabled={index === links.length - 1} onClick={() => navigate("next")} aria-label={t("nextMedia")}><ChevronRight size={20} /></button>
      </footer>}
    </div>
  </OverlayDialog>;
}

/** Only the slide remounts. The dialog keeps its history layer and original opener. */
function ArtifactSlide({ sessionId, messageId, href, onNavigate }: {
  sessionId: string; messageId: string; href: string; onNavigate: (direction: "previous" | "next") => void;
}) {
  const { t } = useI18n();
  const { request, state, bundle, status, waiting, retry } = useArtifact(sessionId, messageId, href);
  const failed = request.isError || state.isError || bundle.isError || status?.status === "failed";
  return <>
    {failed ? <div className="artifact-status" role="alert"><p>{t(errorKeys[status?.error ?? ""] ?? "artifactFailed")}</p>{status?.errorResource && artifactResourceName(status.errorResource) && <p>{t("artifactProblemResource", { name: status.errorResource })}</p>}<button className="secondary-button" type="button" onClick={() => void retry()}><RotateCcw size={16} />{t("retry")}</button></div>
      : bundle.data ? <ArtifactContent bundle={bundle.data} onNavigate={onNavigate} previewUrl={`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(status!.id)}/preview`} />
      : <div className="artifact-status" role="status"><LoaderCircle className="spin" size={24} /><p>{t(waiting ? "artifactWaiting" : "artifactLoading")}</p></div>}
  </>;
}

function ArtifactContent({ bundle, previewUrl, onNavigate }: { bundle: AgentArtifactBundle; previewUrl: string; onNavigate: (direction: "previous" | "next") => void }) {
  const { t } = useI18n();
  const entry = bundle.files.find((file) => file.name === bundle.entry)!;
  const [url, setUrl] = useState("");
  const [imageFailed, setImageFailed] = useState(false);
  const [imageAttempt, setImageAttempt] = useState(0);
  const html = useMemo(() => entry.contentType === "text/html" ? artifactHtml(bundle) : undefined, [entry, bundle]);
  useEffect(() => {
    const bytes = Uint8Array.from(atob(entry.base64), (c) => c.charCodeAt(0));
    const value = URL.createObjectURL(new Blob([html ?? bytes], { type: entry.contentType }));
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [entry, html]);
  return <>
    <div className="artifact-toolbar"><span>{t("artifactSaved")}</span><a className="secondary-button" href={url || undefined} download={entry.name.split("/").at(-1)}><Download size={16} />{t("download")}</a></div>
    {Boolean(bundle.skippedResources?.length) && <div className="artifact-help" role="status">{t("artifactSkippedHelp")}<ul>{bundle.skippedResources!.map(name => <li key={name}>{name}</li>)}</ul></div>}
    {html !== undefined ? <><p className="artifact-help">{t("artifactHtmlHelp")}</p><iframe title={entry.name} sandbox="allow-scripts" referrerPolicy="no-referrer" src={previewUrl} onLoad={(event) => {
        event.currentTarget.contentWindow?.postMessage({ type: "missiongo-artifact-preview", html }, "*");
      }} /></>
      : entry.contentType.startsWith("image/") ? <div className="artifact-image">{imageFailed ? <div className="artifact-status" role="alert"><p>{t("agentImageUnavailable")}</p><button className="secondary-button" type="button" onClick={() => { setImageFailed(false); setImageAttempt(value => value + 1); }}>{t("retry")}</button></div>
        : url && <ZoomableImage key={imageAttempt} src={url} alt={entry.name} onSwipe={onNavigate} onError={() => setImageFailed(true)} />}</div>
      : entry.contentType === "application/pdf" ? <iframe title={entry.name} sandbox="allow-scripts allow-same-origin" src={url || undefined} />
      : entry.contentType === "text/markdown" ? <div className="artifact-document"><MarkdownText resolveResourceUrl={(href) => {
        try {
          const resolved = new URL(href, `https://artifact.invalid/${bundle.entry}`);
          const file = resolved.origin === "https://artifact.invalid" && bundle.files.find((resource) => resource.name === decodeURIComponent(resolved.pathname.slice(1)) && resource.contentType.startsWith("image/"));
          return file ? artifactDataUrl(file) : "about:blank";
        } catch { return "about:blank"; }
      }}>{artifactText(entry)}</MarkdownText></div>
      : <pre className="artifact-document">{artifactText(entry)}</pre>}
  </>;
}
