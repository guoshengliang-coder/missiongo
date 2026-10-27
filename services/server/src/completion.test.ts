import { describe, expect, it } from "vitest";
import { normalizeCompletion } from "./completion.js";

describe("completion references",()=>{
 it("reads old GitHub links and nested self-hosted GitLab links",()=>{
  expect(normalizeCompletion({pullRequestUrl:"https://github.com/example/project/pull/12/"})).toEqual({kind:"github",url:"https://github.com/example/project/pull/12"});
  expect(normalizeCompletion({pullRequestUrl:"https://git.example.test/group/sub/project/-/merge_requests/8"}).kind).toBe("gitlab");
 });
 it.each([{}, {pullRequestUrl:"http://github.com/example/project/pull/1"},
  {completion:{kind:"github",url:"https://github.com/example/project/pull/1?token=secret"}},
  {completion:{kind:"gitlab",url:"https://user:password@git.example.test/group/project/-/merge_requests/1"}},
  {completion:{kind:"commit",commit:"a".repeat(40),targetBranch:"--help"}},
  {completion:{kind:"commit",commit:"a".repeat(40),targetBranch:"../other"}},
  {completion:{kind:"commit",commit:"a".repeat(40),targetBranch:"main"},pullRequestUrl:"https://github.com/example/project/pull/1"},
 ])("rejects missing, conflicting or unsafe references", input=>expect(()=>normalizeCompletion(input)).toThrow());
});
