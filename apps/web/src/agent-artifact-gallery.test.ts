import { expect, test } from "vitest";
import { artifactGalleryLinks } from "./agent-artifact-gallery";

test("message gallery follows explicit mixed image/HTML order and canonical path identity", () => {
  expect(artifactGalleryLinks('[first](</tmp/output/a b.PNG>) [same](file:///tmp/output/a%20b.PNG) [doc](/tmp/output/note.md) [html](sandbox:/tmp/output/p.htm) ![svg](/tmp/output/x.svg) [pdf](/tmp/output/note.pdf) [external](https://example.test/a.png)'))
    .toEqual(["/tmp/output/a b.PNG", "sandbox:/tmp/output/p.htm", "/tmp/output/x.svg"]);
});

test("does not discover unlinked files, dependencies or other message content", () => {
  expect(artifactGalleryLinks('/tmp/output/a.png <img src="/tmp/output/b.png"> [css](/tmp/output/main.css) [bad](/tmp/output/../x.html)')).toEqual([]);
  expect(artifactGalleryLinks('[one](/tmp/output/one.html)')).toEqual(["/tmp/output/one.html"]);
});
