import { expect, it } from "vitest";
import { localArtifactLinks, localArtifactImageLinks, localArtifactPath, artifactReferences, artifactRelativeResource, ARTIFACT_CONTENT_TYPES } from "./agent-artifacts.js";

it("recognizes local output links while keeping web routes and hostile protocols out", () => {
  expect(localArtifactLinks("[图](/tmp/fixture-output/a.png) [原型](file:///tmp/fixture-output/a.html) ![图](sandbox:/mnt/data/chart.png) [空格](</tmp/fixture-output/a b.pdf>)"))
    .toEqual(["/tmp/fixture-output/a.png", "file:///tmp/fixture-output/a.html", "sandbox:/mnt/data/chart.png", "/tmp/fixture-output/a b.pdf"]);
  expect(localArtifactPath("file:///tmp/fixture-output/a%20b.pdf#page=2")).toBe("/tmp/fixture-output/a b.pdf");
  for (const path of ["/api/v1/items", "https://example.test/image.png", "javascript:alert(1)", "file://remote/tmp/a", "/tmp/%2e%2e/secret", "/tmp/a%00.png", "/tmp/a\\b.png"]) expect(localArtifactPath(path)).toBeUndefined();
});

it("deduplicates explicit local images and never auto-fetches remote URLs or documents", () => {
  expect(localArtifactImageLinks("![one](</tmp/output/a b.png>) [same](file:///tmp/output/a%20b.png) [pdf](/tmp/output/report.pdf) [web](https://example.test/a.png) [webp](/tmp/output/preview.WEBP) /tmp/output/unlinked.png"))
    .toEqual(["/tmp/output/a b.png", "/tmp/output/preview.WEBP"]);
});

it("distinguishes download links from rendering dependencies without interpreting script URL APIs", () => {
  const refs = artifactReferences(`<a href="data.jsonl">Data</a><img data-src="lazy.png" src="image.png"><style>body{background:url(bg.png)}</style><script type="module">import './app.js'; URL.revokeObjectURL(blob);</script>`, "text/html");
  expect(refs).toEqual(expect.arrayContaining([{ reference: "data.jsonl", download: true }, { reference: "image.png", download: false }, { reference: "bg.png", download: false }, { reference: "./app.js", download: false }]));
  expect(refs).toHaveLength(4);
  expect(ARTIFACT_CONTENT_TYPES["constructor"]).toBeUndefined();
  expect(ARTIFACT_CONTENT_TYPES["__proto__"]).toBeUndefined();
  expect(artifactReferences("![plot](image.png) [data](data.jsonl)", "text/markdown")).toEqual([{ reference: "image.png", download: false }, { reference: "data.jsonl", download: true }]);
  expect(artifactRelativeResource("../image.png", "assets/site.css")).toBe("image.png");
  for (const ref of ["../../secret", "/absolute", "%2fabsolute", "%5csecret", ".hidden/../image.png", "%00.png"]) expect(() => artifactRelativeResource(ref, "report.html")).toThrow();
  expect(artifactRelativeResource("https://example.test/a.png", "report.html")).toBeUndefined();
});
