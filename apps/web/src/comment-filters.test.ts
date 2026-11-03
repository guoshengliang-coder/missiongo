import {describe,expect,it} from "vitest";
import {COMMENT_CATEGORIES,commentFilterKey,parseCommentFilters} from "./comment-filters";

describe("local comment filter preferences",()=>{
  it("defaults missing, invalid and unknown values to all categories",()=>{
    for(const raw of [null,"broken","{}",'["unknown"]'])expect(parseCommentFilters(raw)).toEqual(COMMENT_CATEGORIES);
  });
  it("preserves deliberate empty selections and normalizes duplicate choices",()=>{
    expect(parseCommentFilters("[]")).toEqual([]);
    expect(parseCommentFilters('["agent","human","agent"]')).toEqual(["human","agent"]);
  });
  it("isolates accounts without making preferences item-specific",()=>{
    expect(commentFilterKey("a:b")).not.toBe(commentFilterKey("a%3Ab"));
    expect(commentFilterKey("first")).not.toBe(commentFilterKey("second"));
  });
});
