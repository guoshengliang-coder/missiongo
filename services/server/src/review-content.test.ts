import { expect, it } from "vitest";
import { reviewContentPage } from "./review-content.js";

it("reads Unicode content exactly and rejects stale or unbound continuations", () => {
  const value={plan:"方案 🧑‍💻".repeat(3000),validation:"验证边界",approved:false};
  let page=reviewContentPage(value,0,113);let text=page.text;
  while(page.nextOffset!==undefined) {
    page=reviewContentPage(value,page.nextOffset,113,page.revision);text+=page.text;
  }
  expect(JSON.parse(text)).toEqual(value);
  expect(()=>reviewContentPage(value,1,100)).toThrow(/expectedRevision/);
  expect(()=>reviewContentPage({...value,approved:true},113,100,page.revision)).toThrow(/changed/);
});
