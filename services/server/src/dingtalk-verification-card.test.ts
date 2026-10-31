import { describe, expect, it } from "vitest";
import { buildVerificationCard, verificationInstructions, verificationSummary } from "./dingtalk-verification-card.js";

const input={projectName:"示例项目",itemKey:"TEST-123",itemTitle:"筛选框内容显示不全",description:"选择较长的筛选项后，完整内容被截断，无法确认当前选择。",itemUrl:"https://example.test/?item=TEST-123",payload:{}};
const released=(artifacts:string[])=>({reason:"release_verified",receiptDigest:"synthetic-receipt",releases:artifacts.map(artifact=>({artifact,version:"synthetic-version"}))});

describe("delivered card content",()=>{
  it("separates identity, original context and acceptance instructions without exposing release metadata",()=>{
    const card=buildVerificationCard({...input,payload:released(["web"])});
    expect(card.headerTitle).toBe("已交付 TEST-123 ｜ 请验收");
    expect(card.heading).toBe("<font sizeToken=common_h3_text_style__font_size>示例项目 | **筛选框内容显示不全**</font>");
    expect(card.summary).toBe(input.description);
    expect(card.verification).toBe("Web：重新打开网站，使用后验收。");
    expect(card.itemUrl).toBe(input.itemUrl);
    expect(JSON.stringify(card)).not.toMatch(/synthetic-version|synthetic-receipt|验收版本|交付时间/);
  });
  it("lists each actually delivered platform once in a stable order",()=>{
    const lines=verificationInstructions(released(["windowsApp","web","iosApp","macosApp","androidApp","web"])).split("\n");
    expect(lines).toEqual([
      "Web：重新打开网站，使用后验收。",
      "Android：下载并安装最新版本，使用后验收。",
      "iOS：更新至最新版本，使用后验收。",
      "macOS：下载并安装最新的 Mac 版本，使用后验收。",
      "Windows：下载并安装最新的 Windows 版本，使用后验收。",
    ]);
  });
  it("does not infer platform or download instructions without verified evidence",()=>{
    for(const payload of [{}, {...released(["web"]),reason:"manual_override"}, {...released(["web"]),receiptDigest:undefined}, released([])]) {
      expect(verificationInstructions(payload)).toBe("请进入条目查看交付内容和验收环境后验收。");
    }
    expect(verificationInstructions(released(["gateway"]))).toBe("其他产物：请进入条目查看交付内容和验收环境后验收。");
  });
  it("omits empty and duplicate summaries and removes code, images and active links",()=>{
    expect(verificationSummary("",input.itemTitle)).toBe("");
    expect(verificationSummary(`**${input.itemTitle}**`,input.itemTitle)).toBe("");
    const summary=verificationSummary("# 说明\n原始问题 [详情](https://example.test) ![image](https://example.test/image)\n```js\nalert(1)\n```",input.itemTitle);
    expect(summary).toBe("原始问题 详情");
  });
  it("keeps normal long titles complete and bounds oversized UTF-8 variables without broken markup",()=>{
    const title="在多个筛选条件叠加后，切换列表并返回时仍应保留完整的选择内容与筛选状态";
    expect(buildVerificationCard({...input,itemTitle:title}).heading).toBe(`<font sizeToken=common_h3_text_style__font_size>示例项目 | **${title}**</font>`);
    const card=buildVerificationCard({...input,projectName:"项".repeat(600),itemTitle:"题😀".repeat(600),description:"说明😀".repeat(600)});
    for(const [key,value] of Object.entries(card)) {
      expect(Buffer.byteLength(value),key).toBeLessThanOrEqual(1000);
      expect(value,key).not.toContain("�");
    }
    expect(card.heading).toMatch(/…\*\*<\/font>$/);
    expect(card.summary).toMatch(/…$/);
  });
  it("passes a configured theme without inventing status-to-color rules",()=>{
    expect(buildVerificationCard(input).theme).toBe("blue");
    expect(buildVerificationCard(input,"orange").theme).toBe("orange");
  });
});
