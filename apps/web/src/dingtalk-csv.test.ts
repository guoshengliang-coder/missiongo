import { describe,expect,it } from "vitest";
import { parseDingTalkCsv } from "./dingtalk-csv";
describe("DingTalk binding CSV",()=>{
  it("accepts BOM, CRLF and quoted fields without interpreting spreadsheet formulas",()=>{
    expect(parseDingTalkCsv('\uFEFF邮箱,钉钉用户 ID,姓名,部门\r\na@example.test,employee-a,"姓名,别名","=text"\r\n')).toEqual([{email:"a@example.test",userId:"employee-a",name:"姓名,别名",department:"=text"}]);
  });
  it("rejects malformed or incomplete input before preview",()=>{
    for(const csv of ['email,userId\na,b','email,userId,name,department\na,b,"open,department','email,userId,name,department\na,b,c,d,e'])expect(()=>parseDingTalkCsv(csv)).toThrow();
  });
});
