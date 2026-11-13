import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { AgentSessionMessage } from "./types";

type Anchor = {id:string; top:number};
/** Receipts can arrive or vanish above the viewport without constituting new
 * output. Keep a few visible source anchors; explicit history prepends already
 * have an anchor in useAgentHistory and must not be compensated twice. */
export function useTranscriptAnchor(container: RefObject<HTMLDivElement | null>, scope: string, followLatest: boolean,
  historyRevision: number, messages: readonly AgentSessionMessage[], receiptSignature = "") {
  const previous = useRef<{scope:string; revision:number; anchors:Anchor[];
    messages:readonly AgentSessionMessage[]; receiptSignature:string} | null>(null);
  const remember = useCallback(() => {
    const box = container.current;
    if (!box) { previous.current = null; return; }
    const top = box.getBoundingClientRect().top;
    const anchors: Anchor[] = [];
    for (const element of box.querySelectorAll<HTMLElement>("[data-agent-message-id]")) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom <= top) continue;
      anchors.push({id:element.dataset.agentMessageId!,top:rect.top-top});
      if (anchors.length === 3) break;
    }
    previous.current = {scope, revision:historyRevision, anchors, messages, receiptSignature};
  }, [container, scope, historyRevision, messages, receiptSignature]);
  useLayoutEffect(() => {
    const box = container.current;
    // A follow-mode change can be an intermediate event of an explicit smooth
    // scroll. Only compensate changed content, never interrupt that navigation.
    if (box && !followLatest && previous.current?.scope === scope && previous.current.revision === historyRevision
      && (previous.current.messages !== messages || previous.current.receiptSignature !== receiptSignature)) {
      const elements = [...box.querySelectorAll<HTMLElement>("[data-agent-message-id]")];
      for (const anchor of previous.current.anchors) {
        const element = elements.find(node => node.dataset.agentMessageId === anchor.id);
        if (!element) continue;
        box.scrollTop += element.getBoundingClientRect().top - box.getBoundingClientRect().top - anchor.top;
        break;
      }
    }
    remember();
  }, [container, scope, followLatest, historyRevision, messages, receiptSignature, remember]);
  return remember;
}

export function revealTranscriptReply(box: HTMLDivElement | null, ids: readonly string[]) {
  if (!box) return;
  const element = [...box.querySelectorAll<HTMLElement>("[data-agent-message-id]")]
    .find(node => ids.some(id => node.dataset.agentMessageId === `user:${id}`));
  if (!element) return;
  box.scrollTop += element.getBoundingClientRect().top - box.getBoundingClientRect().top;
  element.querySelector<HTMLButtonElement>("button")?.focus({preventScroll:true});
}
