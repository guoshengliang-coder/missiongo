import "@vitejs/plugin-react/preamble";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommonCommandMenu, CommonCommandProvider, useCommonCommands, useCommandTarget } from "../../apps/web/src/common-commands";
import { I18nProvider } from "../../apps/web/src/i18n";
import { holdOverlayHistory } from "../../apps/web/src/overlay";
import "../../apps/web/src/styles.css";

declare global {
 interface Window { commandAudit: { hold: () => void; release: () => void; clear: () => void; settingsVisits: () => number; instanceId: string } }
}
function Harness() {
 const commands = useCommonCommands()!;
 const [draft, setDraft] = useState("已有草稿");
 const undo = useCommandTarget("audit", draft, setDraft, false);
 const release = useRef(() => {});
 const settingsVisits = useRef(0);
 const instanceId = useRef(crypto.randomUUID());
 useEffect(() => {
  const visit = () => { settingsVisits.current++; };
  window.addEventListener("missiongo:common-command-settings", visit);
  return () => window.removeEventListener("missiongo:common-command-settings", visit);
 }, []);
 useEffect(() => {
  window.commandAudit = { hold: () => { release.current = holdOverlayHistory(); }, release: () => release.current(), clear: commands.clear, settingsVisits: () => settingsVisits.current, instanceId: instanceId.current };
 }, [commands]);
 return <main>
  <textarea aria-label="草稿" data-command-target="audit" value={draft} onChange={e => setDraft(e.target.value)}/>
  <button type="button" onClick={() => commands.open("audit")}>打开指令</button>
  <CommonCommandMenu targetId="audit"/>
  {undo}
 </main>;
}
const container = document.getElementById("command-audit-root")! as HTMLElement & { auditRoot?: ReturnType<typeof createRoot>; auditClient?: QueryClient };
const root = container.auditRoot ??= createRoot(container);
const client = container.auditClient ??= new QueryClient();
root.render(
 <I18nProvider><QueryClientProvider client={client}><CommonCommandProvider><Harness/></CommonCommandProvider></QueryClientProvider></I18nProvider>
);
