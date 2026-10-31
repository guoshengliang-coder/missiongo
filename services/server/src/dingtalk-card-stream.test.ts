import { expect,it,vi } from "vitest";
const state=vi.hoisted(()=>({topic:"",listener:null as null|((frame:{data:string;headers:{messageId:string}})=>void),connect:vi.fn(async()=>{}),disconnect:vi.fn(),ack:vi.fn()}));
vi.mock("dingtalk-stream",()=>({TOPIC_CARD:"/v1.0/card/instances/callback",DWClient:class {
  registerCallbackListener(topic:string,listener:typeof state.listener){state.topic=topic;state.listener=listener;return this;}
  connect=state.connect;disconnect=state.disconnect;socketCallBackResponse=state.ack;
}}));
import { DingTalkCardStream } from "./dingtalk-card-stream.js";
import { invalidInput } from "./errors.js";
it("subscribes only card callbacks and acknowledges saved replies or explicit errors without treating robot chat as comments",()=>{
  const onCard=vi.fn((body:unknown)=>{if((body as {invalid?:boolean}).invalid)throw invalidInput("没有评论权限");return {cardData:{cardParamMap:{replySaved:"true"}}};});
  const stream=new DingTalkCardStream("synthetic-app","synthetic-secret",onCard);stream.start();
  expect(state.topic).toBe("/v1.0/card/instances/callback");
  state.listener!({data:'{"valid":true}',headers:{messageId:"one"}});expect(state.ack).toHaveBeenLastCalledWith("one",{cardData:{cardParamMap:{replySaved:"true"}}});
  state.listener!({data:'{"invalid":true}',headers:{messageId:"two"}});expect(state.ack).toHaveBeenLastCalledWith("two",{cardData:{cardParamMap:{replySaved:"false",replyStatus:"没有评论权限"}}});
  state.listener!({data:'invalid-json',headers:{messageId:"three"}});expect(onCard).toHaveBeenCalledTimes(2);
  stream.close();expect(state.disconnect).toHaveBeenCalledOnce();
});
