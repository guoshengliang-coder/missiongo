import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, LoaderCircle, RotateCcw, X } from "lucide-react";
import { localArtifactLinks, localArtifactPath, type AgentArtifactBundle } from "@missiongo/domain";
import { createPortal } from "react-dom";

import { api } from "./api";
import { useI18n, type MessageKey } from "./i18n";
import { MarkdownText } from "./markdown-text";
import { artifactDataUrl, artifactHtml, artifactText } from "./agent-artifact-preview";

const errorKeys: Record<string, MessageKey> = {
  node_unavailable: "artifactNodeUnavailable", file_missing: "artifactFileMissing", unsupported: "artifactUnsupported",
  reference_missing: "artifactReferenceMissing", file_denied: "artifactFileDenied", too_large: "artifactTooLarge", resource_missing: "artifactResourceMissing",
};

export function AgentArtifactMarkdown({ text, sessionId, messageId }: { text: string; sessionId: string; messageId: string }) {
  const [href, setHref] = useState<string>();
  const closeViewer = useCallback(() => setHref(undefined), []);
  return <>
    <MarkdownText onLocalArtifactOpen={(value) => setHref(localArtifactLinks(text).find((link) => localArtifactPath(link) === localArtifactPath(value)) ?? value)}>{text}</MarkdownText>
    {href && createPortal(<ArtifactViewer key={`${sessionId}:${messageId}:${href}`} sessionId={sessionId} messageId={messageId} href={href} onClose={closeViewer} />, document.body)}
  </>;
}

function ArtifactViewer({ sessionId, messageId, href, onClose }: { sessionId: string; messageId: string; href: string; onClose: () => void }) {
  const { t } = useI18n();
  const close = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const [waiting, setWaiting] = useState(false);
  const request = useQuery({ queryKey: ["artifact-request", sessionId, messageId, href], queryFn: () => api.requestAgentArtifact(sessionId, messageId, href), retry: false, staleTime: 0, gcTime: 0 });
  const state = useQuery({ queryKey: ["artifact-state", sessionId, request.data?.id], queryFn: () => api.agentArtifact(sessionId, request.data!.id), enabled: Boolean(request.data),
    refetchInterval: (query) => query.state.data?.status === "pending" ? 1500 : false });
  const status = state.data && state.dataUpdatedAt >= request.dataUpdatedAt ? state.data : request.data;
  const bundle = useQuery({ queryKey: ["artifact-bundle", sessionId, status?.id], queryFn: () => api.agentArtifactBundle(sessionId, status!.id), enabled: status?.status === "ready", staleTime: Infinity });
  useEffect(() => {
    const original = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("keydown", escape, true); original?.focus(); };
  }, [onClose]);
  useEffect(() => {
    setWaiting(false);
    const timer = setTimeout(() => setWaiting(true), 20_000);
    return () => clearTimeout(timer);
  }, [request.dataUpdatedAt]);
  const failed = request.isError || state.isError || bundle.isError || status?.status === "failed";
  return <div className="artifact-backdrop" onClick={onClose}>
    <div className="artifact-viewer" ref={dialog} role="dialog" aria-modal="true" aria-label={t("artifactPreview")} onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const nodes = dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], iframe, [tabindex='0']");
        const first = nodes?.[0]; const last = nodes?.[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <header><strong>{status?.filename ?? t("artifactPreview")}</strong><button ref={close} className="icon-button" type="button" onClick={onClose} aria-label={t("close")}><X size={20} /></button></header>
      {failed ? <div className="artifact-status" role="alert"><p>{t(errorKeys[status?.error ?? ""] ?? "artifactFailed")}</p><button className="secondary-button" type="button" onClick={() => { void request.refetch().then(() => state.refetch()); }}><RotateCcw size={16} />{t("retry")}</button></div>
        : bundle.data ? <ArtifactContent bundle={bundle.data} previewUrl={`/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(status!.id)}/preview`} />
        : <div className="artifact-status" role="status"><LoaderCircle className="spin" size={24} /><p>{t(waiting ? "artifactWaiting" : "artifactLoading")}</p></div>}
    </div>
  </div>;
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
    <div className="artifact-toolbar"><span>{t("artifactSaved")}</span><a className="secondary-button" href={url} download={entry.name.split("/").at(-1)}><Download size={16} />{t("download")}</a></div>
    {html !== undefined ? <><p className="artifact-help">{t("artifactHtmlHelp")}</p><iframe title={entry.name} sandbox="allow-scripts" referrerPolicy="no-referrer" src={previewUrl} onLoad={(event) => {
        event.currentTarget.contentWindow?.postMessage({ type: "missiongo-artifact-preview", html }, "*");
      }} /></>
      : entry.contentType.startsWith("image/") ? <div className="artifact-image"><img src={url} alt={entry.name} /></div>
      : entry.contentType === "application/pdf" ? <iframe title={entry.name} sandbox="allow-scripts allow-same-origin" src={url} />
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
