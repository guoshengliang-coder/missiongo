import { OverlayDialog } from "./overlay";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, LoaderCircle, RotateCcw, X } from "lucide-react";
import { localArtifactLinks, localArtifactImageLinks, localArtifactPath, type AgentArtifactBundle } from "@missiongo/domain";
import { createPortal } from "react-dom";

import { api } from "./api";
import { useI18n, type MessageKey } from "./i18n";
import { MarkdownText } from "./markdown-text";
import { artifactDataUrl, artifactHtml, artifactText } from "./agent-artifact-preview";

const errorKeys: Record<string, MessageKey> = {
  node_unavailable: "artifactNodeUnavailable", file_missing: "artifactFileMissing", unsupported: "artifactUnsupported",
  reference_missing: "artifactReferenceMissing", file_denied: "artifactFileDenied", too_large: "artifactTooLarge", resource_missing: "artifactResourceMissing",
};

export function AgentArtifactMarkdown({ text, sessionId, messageId, onImageLoad }: { text: string; sessionId: string; messageId: string; onImageLoad?: (() => void) | undefined }) {
  const [href, setHref] = useState<string>();
  const closeViewer = useCallback(() => setHref(undefined), []);
  const openViewer = useCallback((value: string) => setHref(localArtifactLinks(text).find((link) => localArtifactPath(link) === localArtifactPath(value)) ?? value), [text]);
  const images = useMemo(() => localArtifactImageLinks(text), [text]);
  return <>
    <MarkdownText onLocalArtifactOpen={openViewer} hideLocalImages>{text}</MarkdownText>
    {images.length > 0 && <div className="agent-output-images">{images.map((image) =>
      <ArtifactImage key={`${sessionId}:${messageId}:${image}`} sessionId={sessionId} messageId={messageId} href={image} onOpen={() => openViewer(image)} onLoad={onImageLoad} />)}</div>}
    {href && createPortal(<ArtifactViewer key={`${sessionId}:${messageId}:${href}`} sessionId={sessionId} messageId={messageId} href={href} onClose={closeViewer} />, document.body)}
  </>;
}

/** Shared request/cache for inline thumbnails and the full-size viewer. No raw file URL reaches the browser. */
function useArtifact(sessionId: string, messageId: string, href: string) {
  const [waiting, setWaiting] = useState(false);
  const request = useQuery({ queryKey: ["artifact-request", sessionId, messageId, href], queryFn: () => api.requestAgentArtifact(sessionId, messageId, href), retry: false, staleTime: Infinity });
  const state = useQuery({ queryKey: ["artifact-state", sessionId, request.data?.id], queryFn: () => api.agentArtifact(sessionId, request.data!.id), enabled: Boolean(request.data),
    refetchInterval: (query) => query.state.data?.status === "pending" && Date.now() - request.dataUpdatedAt < 90_000 ? 1500 : false });
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
    {failed ? <div className="agent-output-image-state" role="alert"><span>{t(errorKeys[status?.error ?? ""] ?? "agentImageUnavailable")}</span>
      <button type="button" className="artifact-link" onClick={() => { setDecodeFailed(false); void retry(); }}>{t("retry")}</button></div>
      : url ? <button type="button" className="agent-output-image-open" aria-label={t("agentImagePreview")} onClick={onOpen}>
        <img src={url} alt={t("agentImagePreview")} onLoad={onLoad} onError={() => setDecodeFailed(true)} />
      </button> : <div className="agent-output-image-state" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />
        <span>{t(waiting ? "artifactWaiting" : "agentImageLoading")}</span>
        {waiting && <button type="button" className="artifact-link" onClick={() => void retry()}>{t("retry")}</button>}
      </div>}
  </div>;
}

function ArtifactViewer({ sessionId, messageId, href, onClose }: { sessionId: string; messageId: string; href: string; onClose: () => void }) {
  const { t } = useI18n();
  const { request, state, bundle, status, waiting, retry } = useArtifact(sessionId, messageId, href);
  const failed = request.isError || state.isError || bundle.isError || status?.status === "failed";
  return <OverlayDialog className="artifact-backdrop" onClose={onClose} aria-label={t("artifactPreview")}>
    <div className="artifact-viewer">
      <header><strong>{status?.filename ?? t("artifactPreview")}</strong><button className="icon-button" type="button" onClick={onClose} aria-label={t("close")}><X size={20} /></button></header>
      {failed ? <div className="artifact-status" role="alert"><p>{t(errorKeys[status?.error ?? ""] ?? "artifactFailed")}</p><button className="secondary-button" type="button" onClick={() => void retry()}><RotateCcw size={16} />{t("retry")}</button></div>
        : bundle.data ? <ArtifactContent bundle={bundle.data} previewUrl={`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(status!.id)}/preview`} />
        : <div className="artifact-status" role="status"><LoaderCircle className="spin" size={24} /><p>{t(waiting ? "artifactWaiting" : "artifactLoading")}</p></div>}
    </div>
  </OverlayDialog>;
}

function ArtifactContent({ bundle, previewUrl }: { bundle: AgentArtifactBundle; previewUrl: string }) {
  const { t } = useI18n();
  const entry = bundle.files.find((file) => file.name === bundle.entry)!;
  const [url, setUrl] = useState("");
  const html = useMemo(() => entry.contentType === "text/html" ? artifactHtml(bundle) : undefined, [entry, bundle]);
  useEffect(() => {
    const bytes = Uint8Array.from(atob(entry.base64), (c) => c.charCodeAt(0));
    const value = URL.createObjectURL(new Blob([html ?? bytes], { type: entry.contentType }));
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [entry, html]);
  return <>
    <div className="artifact-toolbar"><span>{t("artifactSaved")}</span><a className="secondary-button" href={url || undefined} download={entry.name.split("/").at(-1)}><Download size={16} />{t("download")}</a></div>
    {html !== undefined ? <><p className="artifact-help">{t("artifactHtmlHelp")}</p><iframe title={entry.name} sandbox="allow-scripts" referrerPolicy="no-referrer" src={previewUrl} onLoad={(event) => {
        event.currentTarget.contentWindow?.postMessage({ type: "missiongo-artifact-preview", html }, "*");
      }} /></>
      : entry.contentType.startsWith("image/") ? <div className="artifact-image">{url && <img src={url} alt={entry.name} />}</div>
      : entry.contentType === "application/pdf" ? <iframe title={entry.name} sandbox="allow-scripts allow-same-origin" src={url || undefined} />
      : entry.contentType === "text/markdown" ? <div className="artifact-document"><MarkdownText resolveResourceUrl={(href) => {
        try {
          const resolved = new URL(href, `https://artifact.invalid/${bundle.entry}`);
          const file = resolved.origin === "https://artifact.invalid" && bundle.files.find((resource) => resource.name === decodeURIComponent(resolved.pathname.slice(1)) && resource.contentType.startsWith("image/"));
          return file ? artifactDataUrl(file) : undefined;
        } catch { return undefined; }
      }}>{artifactText(entry)}</MarkdownText></div>
      : <pre className="artifact-document">{artifactText(entry)}</pre>}
  </>;
}
