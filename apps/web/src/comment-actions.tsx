import { useEffect, useRef } from "react";
import { MoreHorizontal } from "lucide-react";
import { useI18n } from "./i18n";

export function CommentMoreActions({itemKey,commentId,onWithdraw,onNotice}:{
  itemKey:string; commentId:string; onWithdraw:()=>void; onNotice:(message:string)=>void;
}) {
  const {t}=useI18n();
  const menu=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node))menu.current?.removeAttribute("open");};
    const escape=(event:KeyboardEvent)=>{
      if(event.key!=="Escape" || !menu.current?.open)return;
      event.preventDefault();event.stopPropagation();menu.current.open=false;
      menu.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown",outside);
    document.addEventListener("keydown",escape,true);
    return ()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape,true);};
  },[]);
  return <details className="comment-more-actions" ref={menu} onToggle={event=>{
    const target=event.currentTarget;if(!target.open)return;
    const box=target.getBoundingClientRect(),area=target.closest(".detail-scroll")?.getBoundingClientRect();
    const above=box.top-Math.max(0,area?.top ?? 0),below=Math.min(innerHeight,area?.bottom ?? innerHeight)-box.bottom;
    const menuHeight=target.querySelector(".comment-more-popover")?.scrollHeight ?? 96;
    const openAbove=below<menuHeight+8 && above>below;
    target.dataset.side=openAbove?"above":"below";
    target.style.setProperty("--comment-menu-height",`${Math.max(44,(openAbove?above:below)-8)}px`);
  }} onBlur={event=>{
    if(!event.currentTarget.contains(event.relatedTarget as Node|null))event.currentTarget.open=false;
  }}>
    <summary aria-label={t("commentMoreActions")} title={t("commentMoreActions")}><MoreHorizontal size={17} aria-hidden="true" /></summary>
    <div className="comment-more-popover">
      <button type="button" onClick={async()=>{
        menu.current?.removeAttribute("open");
        const url=new URL(window.location.href);url.searchParams.set("item",itemKey);url.searchParams.set("comment",commentId);
        try {await navigator.clipboard.writeText(url.href);onNotice(t("commentLinkCopied"));}
        catch {onNotice(t("commentLinkCopyFailed"));}
      }}>{t("copyCommentLink")}</button>
      <button type="button" className="comment-withdraw" onClick={()=>{menu.current?.removeAttribute("open");onWithdraw();}}>{t("withdrawComment")}</button>
    </div>
  </details>;
}
