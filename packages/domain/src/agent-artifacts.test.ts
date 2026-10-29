import { expect, it } from "vitest";
import { localArtifactLinks, localArtifactPath } from "./agent-artifacts.js";

it("recognizes local output links while keeping web routes and hostile protocols out", () => {
  expect(localArtifactLinks("[图](/tmp/fixture-output/a.png) [原型](file:///tmp/fixture-output/a.html) ![图](sandbox:/mnt/data/chart.png) [空格](</tmp/fixture-output/a b.pdf>)"))
    .toEqual(["/tmp/fixture-output/a.png", "file:///tmp/fixture-output/a.html", "sandbox:/mnt/data/chart.png", "/tmp/fixture-output/a b.pdf"]);
  expect(localArtifactPath("file:///tmp/fixture-output/a%20b.pdf#page=2")).toBe("/tmp/fixture-output/a b.pdf");
  for (const path of ["/api/v1/items", "https://example.test/image.png", "javascript:alert(1)", "file://remote/tmp/a", "/tmp/%2e%2e/secret", "/tmp/a%00.png", "/tmp/a\\b.png"]) expect(localArtifactPath(path)).toBeUndefined();
});
