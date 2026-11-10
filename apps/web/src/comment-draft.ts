import {useCallback,useSyncExternalStore} from "react";
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

interface DraftSnapshot {
 readonly draft:CommentDraft; readonly failed:boolean; readonly files:readonly File[];
 readonly sending:boolean; readonly revision:number; readonly failure:unknown;
}
interface CommentStore {
 snapshot:DraftSnapshot;
 uploaded:{current:Map<File,string>}; uploadIds:{current:Map<File,string>};
 attempt:{current:{fingerprint:string;key:string}};
 listeners:Set<()=>void>;
}
const stores=new Map<string,CommentStore>();
function storeFor(key:string|null) {
 const id=key ?? "";
 let store=stores.get(id);
 if(!store){const draft=readCommentDraft(key);store={snapshot:{draft,failed:false,files:[],sending:false,revision:0,failure:null},
  uploaded:{current:new Map()},uploadIds:{current:new Map()},attempt:{current:draft.attempt ?? {fingerprint:"",key:""}},listeners:new Set()};stores.set(id,store);}
 return store;
}
function publish(store:CommentStore,change:Partial<DraftSnapshot>) {
 store.snapshot={...store.snapshot,...change};store.listeners.forEach(listener=>listener());
}
function useStore(key:string|null) {
 const store=storeFor(key);
 const subscribe=useCallback((listener:()=>void)=>{store.listeners.add(listener);return()=>{store.listeners.delete(listener);};},[store]);
 const snapshot=useCallback(()=>store.snapshot,[store]);
 return {store,snapshot:useSyncExternalStore(subscribe,snapshot,snapshot)};
}
const scopedKey=(accountId:string,itemKey:string,scope?:string)=>commentDraftKey(accountId,itemKey)+(scope?`:${scope}`:"");
/** A confirmed discard empties the in-memory store and the persisted draft. */
export function discardCommentDraft(accountId:string,itemKey:string,scope?:string){
 const key=scopedKey(accountId,itemKey,scope),store=storeFor(key);
 store.uploaded.current.clear();store.uploadIds.current.clear();store.attempt.current={fingerprint:"",key:""};
 publish(store,{draft:EMPTY_COMMENT_DRAFT,files:[],sending:false,failure:null,failed:false,revision:store.snapshot.revision+1});
 try{localStorage.removeItem(key);}catch{}
}
/** Text, files and the active send share one version across shell remounts. */
export function useCommentDraft(accountId:string,itemKey:string|null,scope?:string) {
 const key=itemKey && accountId?scopedKey(accountId,itemKey,scope):null;
 const {store,snapshot}=useStore(key);
 const update=useCallback((change:CommentDraft|((previous:CommentDraft)=>CommentDraft))=>{
  if(!key)return;
  const draft=typeof change==="function"?change(store.snapshot.draft):change;
  publish(store,{draft,failed:!saveCommentDraft(key,draft),revision:store.snapshot.revision+1});
 },[key,store]);
 return {draft:snapshot.draft,update,storageFailed:snapshot.failed};
}
export function useCommentFiles(accountId:string,itemKey:string,scope?:string) {
 const key=scopedKey(accountId,itemKey,scope);
 const {store,snapshot}=useStore(key);
 const setFiles=useCallback((files:readonly File[])=>{
  const kept=new Set(files);
  for(const file of store.uploaded.current.keys())if(!kept.has(file))store.uploaded.current.delete(file);
  for(const file of store.uploadIds.current.keys())if(!kept.has(file))store.uploadIds.current.delete(file);
  publish(store,{files,revision:store.snapshot.revision+1});
 },[store]);
 const beginSend=()=>{
  if(store.snapshot.sending)throw new Error("Comment send already in progress");
  const revision=store.snapshot.revision;publish(store,{sending:true,failure:null});return revision;
 };
 const saveAttempt=()=>{
  const draft={...store.snapshot.draft,attempt:store.attempt.current};
  publish(store,{draft,failed:!saveCommentDraft(key,draft)});
 };
 const finishSend=(revision:number,success:boolean,failure:unknown=null)=>{
  if(success && store.snapshot.revision===revision){
   store.uploaded.current.clear();store.uploadIds.current.clear();store.attempt.current={fingerprint:"",key:""};
   publish(store,{draft:EMPTY_COMMENT_DRAFT,files:[],sending:false,failure:null,failed:!saveCommentDraft(key,EMPTY_COMMENT_DRAFT),revision:revision+1});
   return true;
  }
  publish(store,{sending:false,failure});return false;
 };
 return {files:snapshot.files,setFiles,uploaded:store.uploaded,uploadIds:store.uploadIds,attempt:store.attempt,
  sending:snapshot.sending,failure:snapshot.failure,beginSend,finishSend,saveAttempt};
}
