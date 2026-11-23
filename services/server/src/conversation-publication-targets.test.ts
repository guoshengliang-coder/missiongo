import {describe,it,expect} from "vitest";
import {publicationActionBounds,assertPublicationVersions,publicationTargetsSchema} from "./conversation-publication-targets.js";
const bounds={requiredArtifacts:["androidApp","web"],declaredArtifacts:["androidApp","androidSdk","web"],targets:[{artifact:"androidApp",version:"0.1.204"},{artifact:"web"}]};
describe("reviewed publication constraints",()=>{
  it.each(["合并 PR #764 并发布 Android 0.1.204 和 Web","publish androidApp 0.1.204 and Web/Server"])("resolves exact artifacts and version: %s",text=>{
    const parsed=publicationActionBounds(text,bounds);
    expect(parsed.artifacts.sort()).toEqual(["androidApp","web"]);expect(parsed.text).not.toContain("0.1.204");
  });
  it.each([
    ["发布 Android 0.1.205 和 Web","version_mismatch"],
    ["发布 Android 0.1.204 和 Web 1.2.3","version_evidence_missing"],
    ["发布 Android","artifact_subset"],
    ["发布 Android SDK 和 Web","artifact_mismatch"],
    ["发布 Web 和 Web","artifact_ambiguous"],
  ])("rejects mismatched constraint: %s",(text,reason)=>{
    expect(()=>publicationActionBounds(text!,bounds)).toThrowError(expect.objectContaining({code:`conversation_integration_${reason}`}));
  });
  it("prefers canonical Android identifiers and checks the frozen scope", () => {
    const declaredArtifacts = [...bounds.declaredArtifacts, "android"];
    const hermes = {
      requiredArtifacts: ["android", "web"],
      declaredArtifacts,
      targets: [{ artifact: "android", version: "0.1.204" }, { artifact: "web" }],
    };
    expect(publicationActionBounds("发布 Android 0.1.204 和 Web", hermes).artifacts).toEqual(["android", "web"]);
    expect(() => publicationActionBounds("发布 Android 和 Web", { ...bounds, declaredArtifacts })).toThrow(/不在已审阅/);
    expect(publicationActionBounds("发布 androidApp 和 Web", { ...bounds, declaredArtifacts }).artifacts).toEqual(["androidApp", "web"]);
  });
  it("rejects an adjacent unknown version instead of treating it as free narration",()=>{
    expect(()=>publicationActionBounds("发布 Web Canary",{requiredArtifacts:["web"],declaredArtifacts:["web"]})).toThrow(/版本/);
  });
  it.each(["test","204","1234567","abcdef123","1.2.3-rc.1+build"])("matches declared non-semver and semver constraints: %s",version=>{
    expect(publicationActionBounds(`发布 Web ${version}`,{requiredArtifacts:["web"],declaredArtifacts:["web"],targets:[{artifact:"web",version}]}).artifacts).toEqual(["web"]);
  });
  it("preserves a following PR reference and conjunction rather than consuming them as versions",()=>{
    expect(publicationActionBounds("publish Web PR #12",{requiredArtifacts:["web"],declaredArtifacts:["web"]}).text).toMatch(/PR\s+#12/);
    expect(publicationActionBounds("publish Android and Web",bounds).artifacts.sort()).toEqual(["androidApp","web"]);
  });
  it("requires a matching observed version before publication",()=>{
    expect(()=>assertPublicationVersions(bounds.targets,undefined)).toThrow(/发布前/);
    expect(()=>assertPublicationVersions(bounds.targets,[{artifact:"androidApp",version:"0.1.203"}])).toThrow(/发布前/);
    expect(()=>assertPublicationVersions(bounds.targets,[{artifact:"androidApp",version:"0.1.204"}])).not.toThrow();
    expect(()=>assertPublicationVersions(undefined,undefined)).not.toThrow();
  });
  it("rejects repeated target entries and arbitrary fields",()=>{
    expect(publicationTargetsSchema.safeParse([{artifact:"web"},{artifact:"web"}]).success).toBe(false);
    expect(publicationTargetsSchema.safeParse([{artifact:"web",approved:true}]).success).toBe(false);
  });
});
