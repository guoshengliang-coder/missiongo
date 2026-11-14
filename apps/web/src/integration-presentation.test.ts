import {describe,it,expect} from "vitest";
import type { Batch } from "./merge-console";
import type { IntegrationPublication } from "@missiongo/contracts";
import {integrationPublication,integrationStage,integrationOrder} from "./integration-presentation";
function batch(states:IntegrationPublication[]):Batch {
  return {id:"batch",sessionId:"session",state:"finished",publish:true,deliveries:states.map((_,i)=>String(i)),results:{},
    presentation:{entries:Object.fromEntries(states.map((publication,i)=>[String(i),{title:"Change",summary:"Historical waiting text",pullRequestUrl:"https://github.com/example/project/pull/1",requiredArtifacts:["web"],publication,releases:[]}]))}};
}
describe("integration reading outcomes",()=>{
  it("never infers publication from finished or merge results",()=>{
    const b=batch([]);b.deliveries=["a"];b.results={a:{status:"merged",detail:"published, all checks passed"}};
    expect(integrationPublication(b)).toBe("unknown");expect(integrationPublication(b,"a")).toBe("unknown");
    expect(integrationStage(b,"a")).toBe("merged");
  });
  it.each([
    [["published","not_required"],"published"],[["not_required"],"not_required"],
    [["published","unknown"],"partial"],[["pending","partial"],"partial"],
    [["pending","not_required"],"pending"],[["unknown","pending"],"unknown"],
  ] as [IntegrationPublication[],IntegrationPublication][])("combines %j without discarding missing evidence",(states,result)=>{
    expect(integrationPublication(batch(states))).toBe(result);
  });
  it("keeps frozen deliveries even when a plan or integration record is incomplete",()=>{
    const b=batch(["pending","pending"]);b.integration={protocol:1,revision:1,plans:[],entries:{},events:[]};
    expect(integrationOrder(b)).toEqual(["0","1"]);expect(integrationStage(b,"0")).toBe("queued");
  });
});


it("AND-520 includes extra publication responsibilities in the overall outcome",()=>{
  const b=batch(["published"]);
  b.presentation!.ownedExtras=[{id:"extra",title:"Frozen extra",pendingArtifacts:["web"],publication:"pending"}];
  expect(integrationPublication(b)).toBe("partial");
  b.presentation!.ownedExtras[0]!.publication="unknown";expect(integrationPublication(b)).toBe("partial");
  b.presentation!.ownedExtras[0]!.publication="published";expect(integrationPublication(b)).toBe("published");
});
