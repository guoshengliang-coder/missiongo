import { expect, it } from "vitest";
import { withCurrentRequests } from "./current-session-requests";
import type { AgentSessionMessage } from "./types";
const request: AgentSessionMessage={id:"request",sourceId:"permission-one",role:"agent",occurredAt:"2026-01-01T00:00:00.000Z",text:"Confirm",questions:[{title:"Allow",options:["Yes","No"],key:"授权请求 one"}]};
it("retains a current request outside the recent page and replaces a stale mirror only once",()=>{
  const page: AgentSessionMessage={id:"tail",sourceId:"tail",role:"agent",occurredAt:"2026-01-01T00:00:00.000Z",text:"Later"};
  expect(withCurrentRequests([page],[request])).toEqual([request,page]);
  const changed={...request,text:"Updated source"};
  expect(withCurrentRequests([request,page],[changed])).toEqual([changed,page]);
});
it("does not revive resolved or withdrawn questions from cached historical pages",()=>{
  const answered={...request,id:"answered",sourceId:"answered",questions:[{...request.questions![0]!,answered:"Yes"}]};
  const result=withCurrentRequests([request,answered],[]);
  expect(result[0]!.historical).toBe(true);
  expect(result[0]!.questions).toEqual(request.questions);
  expect(result[1]).toBe(answered);
  expect(withCurrentRequests([request],undefined)).toEqual([request]);
});
