import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./api";
import { localizedErrorText } from "./error-text";
import { useI18n } from "./i18n";
import type { AgentSessionSummary } from "./types";

export function ExternalNativeConnectionPanel({ session }: { session: AgentSessionSummary }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [choosing, setChoosing] = useState(false);
  const [nodeId, setNodeId] = useState("");
  const [showRegistration, setShowRegistration] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const registrationPrompt = t("agentExternalRegisterPrompt", { session: session.id });
  const nodes = useQuery({ queryKey: ["external-native-nodes"], queryFn: api.listNodes, enabled: choosing });
  const mutation = useMutation({
    mutationFn: (node: string | null) => node ? api.connectExternalSession(session.id, node) : api.disconnectExternalSession(session.id),
    onSuccess: async () => {
      setChoosing(false);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["agent-sessions"] }), queryClient.invalidateQueries({ queryKey: ["agent-session", session.id] })]);
    },
  });
  if (session.source !== "external") return null;
  return <div>
    {session.canRegisterNative && session.refKind === "tracking" && <>
      <button type="button" className="secondary-button" onClick={() => setShowRegistration(!showRegistration)}>{t("agentExternalEnableReply")}</button>
      {showRegistration && <div>
        <p>{t("agentExternalRegisterDetail")}</p>
        <p>{registrationPrompt}</p>
        <button type="button" className="secondary-button" onClick={() => {
          setCopyError(false);
          if (!navigator.clipboard) { setCopyError(true); return; }
          void navigator.clipboard.writeText(registrationPrompt).then(() => setCopied(true)).catch(() => setCopyError(true));
        }}>{t(copied ? "agentExternalRegistrationCopied" : "agentExternalCopyRegistration")}</button>
        {copyError && <p>{t("agentExternalCopyRegistrationFailed")}</p>}
      </div>}
    </>}
    {!session.canReply && (session.canRegisterNative || session.canConnectNative) && <details>
      <summary>{t("agentExternalSetup")}</summary>
      <p>{t("agentExternalSetupDetail")}</p>
      <a href="/downloads/missiongo-agent-integration/install.mjs" download="install.mjs">{t("agentExternalDownloadSetup")}</a>
      <p><code>node install.mjs --origin {window.location.origin}</code></p>
      <p>{t("agentExternalSetupClaude")}</p>
    </details>}
    {session.agentKind === "claude_code" && <span>{t("agentExternalClaudeLimit")}</span>}
    {session.canConnectNative && !session.nativeConnection?.nodeId && !choosing && <button type="button" className="secondary-button" onClick={() => setChoosing(true)}>{t("agentExternalConnect")}</button>}
    {choosing && <div>
      <p>{t("agentExternalConnectDetail")}</p>
      <label>{t("agentExternalChooseNode")} <select aria-label={t("agentExternalChooseNode")} value={nodeId} onChange={(event) => setNodeId(event.target.value)}>
        <option value="">{t("agentExternalChooseNode")}</option>
        {nodes.data?.nodes.filter((node) => !node.revokedAt && node.agents.some((agent) => agent.kind === session.agentKind)).map((node) => <option value={node.id} key={node.id}>{node.name}</option>)}
      </select></label>
      <button type="button" className="primary-button" disabled={!nodeId || mutation.isPending} onClick={() => mutation.mutate(nodeId)}>{t("agentExternalConnect")}</button>
      <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={() => setChoosing(false)}>{t("cancel")}</button>
    </div>}
    {session.canDisconnectNative && <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={() => mutation.mutate(null)}>{t("agentExternalDisconnect")}</button>}
    {nodes.isError && <p className="inline-error">{localizedErrorText(nodes.error, t)}</p>}
    {mutation.isError && <p className="inline-error">{localizedErrorText(mutation.error, t)}</p>}
  </div>;
}
