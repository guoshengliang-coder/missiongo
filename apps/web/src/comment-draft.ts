import {useCallback,useRef,useState} from "react";
import type {DraftMention} from "./comment-mentions";

export interface CommentDraft {
  readonly text:string;
  readonly mentions:readonly DraftMention[];
  readonly replyToCommentId:string|null;
  readonly attachmentNames:readonly string[];
  readonly attempt?:{readonly fingerprint:string;readonly key:string};
}
export const EMPTY_COMMENT_DRAFT:CommentDraft={text:"",mentions:[],replyToCommentId:null,attachmentNames:[]};
type DraftStorage=Pick<Storage,"getItem"|"setItem"|"removeItem">;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const commentDraftKey=(accountId:string,itemKey:string)=>`missiongo.comment-draft.v1:${encodeURIComponent(accountId)}:${encodeURIComponent(itemKey)}`;

export function parseCommentDraft(raw:string|null):CommentDraft {
  try {
    const value=JSON.parse(raw ?? "null");
    if(!value || value.version!==1 || typeof value.text!=="string" || value.text.length>100_000)return EMPTY_COMMENT_DRAFT;
    const text:string=value.text;
    const mentions:DraftMention[]=(Array.isArray(value.mentions)?value.mentions:[]).slice(0,100).flatMap((mention:unknown)=>{
      if(!mention || typeof mention!=="object")return [];
      const m=mention as Record<string,unknown>;
      if(!Number.isInteger(m.start) || !Number.isInteger(m.end) || (m.start as number)<0 || (m.end as number)>text.length || (m.end as number)<=(m.start as number) || typeof m.label!=="string" || !m.label
        || text.slice(m.start as number,m.end as number)!==`@${m.label}`)return [];
      const recipient=typeof m.accountId==="string" && m.accountId.length>0 && m.accountId.length<=200?{accountId:m.accountId}:m.target==="all"?{target:"all" as const}:null;
      return recipient?[{start:m.start as number,end:m.end as number,label:m.label,...recipient}]:[];
    });
    return {text,mentions,replyToCommentId:typeof value.replyToCommentId==="string" && UUID.test(value.replyToCommentId)?value.replyToCommentId:null,
      attachmentNames:(Array.isArray(value.attachmentNames)?value.attachmentNames:[]).filter((name:unknown):name is string=>typeof name==="string").slice(0,10).map((name:string)=>name.slice(0,255)),
      ...(typeof value.attempt?.fingerprint==="string" && value.attempt.fingerprint.length<=100_000 && typeof value.attempt.key==="string" && UUID.test(value.attempt.key)
        ?{attempt:{fingerprint:value.attempt.fingerprint,key:value.attempt.key}}:{})};
  } catch {return EMPTY_COMMENT_DRAFT;}
}

export function readCommentDraft(key:string|null,storage?:DraftStorage):CommentDraft {
  if(!key)return EMPTY_COMMENT_DRAFT;
  try {return parseCommentDraft((storage ?? localStorage).getItem(key));}catch{return EMPTY_COMMENT_DRAFT;}
}

export function saveCommentDraft(key:string|null,draft:CommentDraft,storage?:DraftStorage):boolean {
  if(!key)return true;
  try {
    const target=storage ?? localStorage;
    if(!draft.text && !draft.replyToCommentId && !draft.attachmentNames.length)target.removeItem(key);
    else target.setItem(key,JSON.stringify({version:1,...draft}));
    return true;
  }catch{return false;}
}

/** Persist at input time, before a route change or unload can discard the component. */
export function useCommentDraft(accountId:string,itemKey:string|null) {
  const key=itemKey && accountId?commentDraftKey(accountId,itemKey):null;
  const [state,setState]=useState(()=>({key,draft:readCommentDraft(key),failed:false}));
  const current=state.key===key?state:{key,draft:readCommentDraft(key),failed:false};
  if(state.key!==key)setState(current);
  const ref=useRef(current);ref.current=current;
  const update=useCallback((change:CommentDraft|((previous:CommentDraft)=>CommentDraft))=>{
    const previous=ref.current.key===key?ref.current.draft:readCommentDraft(key);
    const draft=typeof change==="function"?change(previous):change;
    const failed=!saveCommentDraft(key,draft);
    // A completed send from an old item may clear that item's draft, never the current one.
    if(ref.current.key===key){ref.current={key,draft,failed};setState(ref.current);}
  },[key]);
  return {draft:current.draft,update,storageFailed:current.failed};
}
