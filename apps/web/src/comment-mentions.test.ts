import { describe,expect,it } from "vitest";
import { editMentions,mentionQuery,mentionAudience } from "./comment-mentions";
describe("draft mentions",()=>{
  it("finds the token at the cursor without treating email addresses as mentions",()=>{
    expect(mentionQuery("ask @张三 later",6)).toEqual({start:4,end:6,query:"张"});
    expect(mentionQuery("a@example.test",4)).toBeNull();expect(mentionQuery("@",1)?.query).toBe("");
  });
  it("removes recipients when their exact token is edited or deleted and shifts surviving spans",()=>{
    const text="@同名 and @同名",tokens=[{start:0,end:3,label:"同名",accountId:"one"},{start:8,end:11,label:"同名",accountId:"two"}];
    const shifted=editMentions(text,"hello "+text,tokens);expect(shifted.map(t=>t.start)).toEqual([6,14]);
    expect(editMentions(text,"@改名 and @同名",tokens).map(t=>t.accountId)).toEqual(["two"]);
    expect(editMentions(text,"and @同名",tokens).map(t=>t.accountId)).toEqual(["two"]);
    expect(mentionAudience([...tokens,tokens[0]!,{start:0,end:4,label:"所有人",target:"all"}])).toEqual({mentionAccountIds:["one","two"],mentionTargets:["all"]});
  });
});
