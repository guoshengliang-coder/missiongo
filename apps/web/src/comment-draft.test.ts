import {describe,expect,it} from "vitest";
import {commentDraftKey,EMPTY_COMMENT_DRAFT,parseCommentDraft,readCommentDraft,saveCommentDraft,type CommentDraft} from "./comment-draft";

const memory=()=>{
  const entries=new Map<string,string>();
  return {getItem:(key:string)=>entries.get(key) ?? null,setItem:(key:string,value:string)=>{entries.set(key,value);},removeItem:(key:string)=>{entries.delete(key);}};
};
const draft:CommentDraft={text:"@Alex please confirm",mentions:[{start:0,end:5,label:"Alex",accountId:"alex"}],replyToCommentId:"12345678-1234-4321-9876-123456789abc",attachmentNames:["notes.txt"]};
describe("comment draft persistence",()=>{
  it("restores the exact recipient and reply target while keeping accounts and items isolated",()=>{
    const storage=memory(),key=commentDraftKey("one","FX-1");
    expect(saveCommentDraft(key,draft,storage)).toBe(true);
    expect(readCommentDraft(key,storage)).toEqual(draft);
    expect(readCommentDraft(commentDraftKey("two","FX-1"),storage)).toEqual(EMPTY_COMMENT_DRAFT);
    expect(readCommentDraft(commentDraftKey("one","FX-2"),storage)).toEqual(EMPTY_COMMENT_DRAFT);
    expect(commentDraftKey("one.two","FX-1")).not.toBe(commentDraftKey("one","two.FX-1"));
  });
  it("removes a successfully sent or emptied draft without touching another item",()=>{
    const storage=memory(),one=commentDraftKey("one","FX-1"),two=commentDraftKey("one","FX-2");
    saveCommentDraft(one,draft,storage);saveCommentDraft(two,draft,storage);
    expect(saveCommentDraft(one,EMPTY_COMMENT_DRAFT,storage)).toBe(true);
    expect(storage.getItem(one)).toBeNull();expect(readCommentDraft(two,storage)).toEqual(draft);
  });
  it("drops damaged mention spans rather than notifying recipients absent from the restored text",()=>{
    expect(parseCommentDraft(JSON.stringify({version:1,...draft,mentions:[...draft.mentions,{start:6,end:10,label:"Alex",accountId:"another"},{start:0,end:5,label:"Alex"}]})).mentions).toEqual(draft.mentions);
    expect(parseCommentDraft(JSON.stringify({version:1,...draft,text:"edited text"})).mentions).toEqual([]);
    expect(parseCommentDraft(JSON.stringify({version:1,...draft,replyToCommentId:"foreign-format"})).replyToCommentId).toBeNull();
  });
  it("survives corrupt, old and oversized local data",()=>{
    for(const raw of [null,"{",'null','[]',JSON.stringify({version:2,...draft}),JSON.stringify({version:1,...draft,text:"x".repeat(100_001)})])expect(parseCommentDraft(raw)).toEqual(EMPTY_COMMENT_DRAFT);
  });
  it("reports failed storage writes while allowing in-memory editing",()=>{
    const storage={getItem:()=>{throw Error("unavailable");},setItem:()=>{throw Error("quota");},removeItem:()=>{throw Error("unavailable");}};
    expect(readCommentDraft("key",storage)).toEqual(EMPTY_COMMENT_DRAFT);
    expect(saveCommentDraft("key",draft,storage)).toBe(false);
    expect(saveCommentDraft("key",EMPTY_COMMENT_DRAFT,storage)).toBe(false);
  });
  it("keeps a valid submission key across a reload so a lost response can be retried safely",()=>{
    const storage=memory(),key=commentDraftKey("one","FX-1"),pending={...draft,attempt:{fingerprint:"same request",key:"12345678-1234-4321-9876-123456789abc"}};
    saveCommentDraft(key,pending,storage);expect(readCommentDraft(key,storage)).toEqual(pending);
    expect(parseCommentDraft(JSON.stringify({version:1,...draft,attempt:{fingerprint:"request",key:"broken"}}))).toEqual(draft);
  });
});
