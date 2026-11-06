import { describe, expect, it } from "vitest";
import { permissionPresentation, permissionReplyText } from "./permission-presentation";
import { questionAnswerText } from "./agent-session-view";
import type { AgentSessionQuestion } from "./types";

const modeOption = "本会话内允许（本会话，建议 1）";
const directoryOption = "本会话内允许（本会话，建议 2）";
const question: AgentSessionQuestion = {
  header: "授权请求", key: "授权请求 request-1", title: "Claude Code 请求使用 Edit",
  options: ["批准", modeOption, directoryOption, "拒绝"],
  detail: `${modeOption}：${JSON.stringify({ type: "setMode", mode: "acceptEdits", destination: "session" })}\n${directoryOption}：${JSON.stringify({ type: "addDirectories", directories: ["/example/repo/fixtures"], destination: "session" })}`,
};
describe("native permission presentation", () => {
  it("distinguishes mode from directory access while preserving the request-bound answer", () => {
    const shown = permissionPresentation(question)!;
    expect(shown.get(modeOption)?.label).toBe("本次会话修改文件不再询问");
    expect(shown.get(directoryOption)?.detail).toContain("修改是否需要确认，仍按当前权限规则执行");
    expect(shown.get(directoryOption)?.detail).toContain("/example/repo/fixtures");
    expect(shown.size).toBe(4);
    expect(questionAnswerText("", question, directoryOption, 1)).toBe(`授权请求 request-1: ${directoryOption}`);
  });
  it("does not reinterpret ordinary questions or unknown updates", () => {
    expect(permissionPresentation({ ...question, header: "问题" })).toBeUndefined();
    expect(permissionPresentation({ ...question, detail: `${modeOption}：{"type":"setMode","mode":"future","destination":"session"}` })?.has(modeOption)).toBe(false);
    expect(permissionPresentation({ ...question, detail: `${modeOption}：null` })?.has(modeOption)).toBe(false);
  });
  it("states persistent destinations without describing them as session-only", () => {
    const shown = permissionPresentation({ ...question, detail: `${modeOption}：{"type":"addDirectories","directories":["relative/path"],"destination":"projectSettings"}` })!;
    expect(shown.get(modeOption)?.detail).toContain("后续会话也会生效");
    expect(shown.get(modeOption)?.detail).toContain("relative/path");
  });
});

it("presents a readable draft while restoring only exact generated answers", () => {
  const wire = `授权请求 request-1: ${directoryOption}`;
  const visible = permissionReplyText([question], wire);
  expect(visible).not.toContain("建议 2");
  expect(visible).toContain("本次会话允许访问指定文件夹");
  expect(permissionReplyText([question], visible, true)).toBe(wire);
  expect(permissionReplyText([question], "我的意见：" + visible, true)).toBe("我的意见：" + visible);
});
