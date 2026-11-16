import { expect, it } from "vitest";
import { bridgeOutput } from "./bridge.js";
import type { Snapshot } from "../../node/src/types.js";

it("prints completed source text when a streamed message keeps its native identity",()=>{
  const seen=new Map<string,string>(),snapshot:Snapshot={status:"active",messages:[{sourceId:"native",role:"agent",text:"正在核对"}]};
  expect(bridgeOutput(snapshot,seen)).toEqual(["正在核对"]);
  expect(bridgeOutput(snapshot,seen)).toEqual([]);
  snapshot.messages[0]!.text="正在核对\n最终结论：两项检查通过。";
  expect(bridgeOutput(snapshot,seen).join("\n")).toContain("最终结论：两项检查通过。");
  expect(bridgeOutput(snapshot,seen)).toEqual([]);
});

it("shows the complete permission scope and option descriptions before a terminal decision",()=>{
  const snapshot:Snapshot={status:"active",messages:[{sourceId:"request-one",role:"agent",text:"Claude Code 请求确认：Bash",questions:[{key:"授权请求 one",title:"请求执行命令",detail:'{"command":"git status","cwd":"fixture"}',options:["批准","拒绝"]}]}],
    approval:{id:"approval-one",kind:"manual",status:"pending",turnId:"turn",action:"访问目录",reason:"读取测试夹具",startedAtMs:1,options:[{id:"accept",kind:"turn",label:"允许本回合",detail:"仅当前回合有效"}]}};
  const output=bridgeOutput(snapshot,new Map()).join("\n");
  for(const text of ["git status","请求执行命令","批准 / 拒绝","读取测试夹具","允许本回合","仅当前回合有效","/approve approval-one <accept>"])expect(output).toContain(text);
});

it("removes terminal controls from every untrusted field and bounds remembered source identities",()=>{
  const snapshot:Snapshot={status:"idle",messages:[{sourceId:"one",role:"agent",text:"body\u001b[2J",questions:[{title:"title\u001b[2J",detail:"scope\u009b2J",options:["choice\u001b[2J"]}]}]};
  const seen=new Map<string,string>();
  const text=bridgeOutput(snapshot,seen).join("\n");
  expect(text).not.toContain("\u001b");expect(text).not.toContain("\u009b");
  for(let i=0;i<100;i++)bridgeOutput({status:"idle",messages:[{sourceId:String(i),role:"agent",text:"message"}]},seen);
  expect(seen.size).toBeLessThanOrEqual(1);
});

it("prints settled questions and source failures without offering obsolete approval commands",()=>{
  const snapshot:Snapshot={status:"unavailable",error:"原会话已断开",messages:[{sourceId:"request",role:"agent",text:"已处理",questions:[{title:"选择",answered:"完成",options:["批准","拒绝"]}]}],
    approval:{id:"done",kind:"manual",status:"approved",turnId:"turn",action:"已处理",startedAtMs:1,options:[{id:"accept",kind:"once"}]}};
  const text=bridgeOutput(snapshot,new Map()).join("\n");
  expect(text).toContain("已回答：完成");expect(text).toContain("原会话已断开");
  expect(text).not.toContain("批准 / 拒绝");expect(text).not.toContain("/approve");
});
