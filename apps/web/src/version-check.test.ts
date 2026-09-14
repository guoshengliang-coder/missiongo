import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { decideUpdate, entryScriptOf, QUIET_BEFORE_RELOAD_MS, type UpdateInputs } from "./version-check";

const builtDocument = `<!doctype html>
<html lang="zh-CN">
  <head>
    <link rel="modulepreload" crossorigin href="/assets/App-Cnf3QwTY.js">
    <script type="module" crossorigin src="/assets/index-B2Kzl8qX.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-Dvpc2WUu.css">
  </head>
  <body><div id="root"></div></body>
</html>`;

describe("Reading which build a document loads", () => {
  it("finds the hashed entry module, not a preloaded chunk or a stylesheet", () => {
    expect(entryScriptOf(builtDocument)).toBe("/assets/index-B2Kzl8qX.js");
  });

  it("accepts the attributes in either order", () => {
    expect(entryScriptOf('<script src="/assets/index-X.js" type="module"></script>')).toBe("/assets/index-X.js");
  });

  it("finds nothing in a development document, which has no hashed entry", () => {
    expect(entryScriptOf('<script type="module" src="/src/main.tsx"></script>')).toBeUndefined();
  });

  it("agrees with the copy the service worker carries", () => {
    // sw.js cannot import this module, so it has its own copy of the pattern.
    // The two answering differently would mean the worker announcing updates the
    // page then decides are not updates.
    const here = dirname(fileURLToPath(import.meta.url));
    const worker = readFileSync(join(here, "../public/sw.js"), "utf8");
    const source = /function entryScriptOf\(html\) \{([\s\S]*?)\n\}/.exec(worker)?.[1];
    expect(source).toBeTruthy();
    const workerEntryScriptOf = new Function("html", source!) as (html: string) => string | undefined;
    for (const html of [builtDocument, '<script src="/assets/index-X.js" type="module"></script>', "<p>none</p>"]) {
      expect(workerEntryScriptOf(html)).toBe(entryScriptOf(html));
    }
  });
});

describe("Deciding what to do about a newer build", () => {
  const quiet: UpdateInputs = {
    current: "/assets/index-old.js",
    latest: "/assets/index-new.js",
    reloadedFor: null,
    hasUnsavedInput: false,
    msSinceInteraction: QUIET_BEFORE_RELOAD_MS,
  };

  it("does nothing when the page already runs the current build", () => {
    expect(decideUpdate({ ...quiet, latest: quiet.current })).toBe("none");
  });

  it("does nothing without evidence: a failed check, or a development page", () => {
    expect(decideUpdate({ ...quiet, latest: undefined })).toBe("none");
    expect(decideUpdate({ ...quiet, current: undefined })).toBe("none");
  });

  it("reloads a quiet page onto the new build", () => {
    // The case this exists for: a phone opened the console and was served the
    // previous build from cache, and nobody has touched it yet.
    expect(decideUpdate(quiet)).toBe("reload");
  });

  it("asks instead of reloading over input that only lives in memory", () => {
    expect(decideUpdate({ ...quiet, hasUnsavedInput: true })).toBe("prompt");
  });

  it("asks instead of reloading under someone who is typing or tapping", () => {
    expect(decideUpdate({ ...quiet, msSinceInteraction: 2_000 })).toBe("prompt");
  });

  it("asks rather than reloading again for a build a reload already failed to reach", () => {
    // Something in front of the server handed the old document back. A second
    // automatic reload would just loop.
    expect(decideUpdate({ ...quiet, reloadedFor: "/assets/index-new.js" })).toBe("prompt");
    expect(decideUpdate({ ...quiet, reloadedFor: "/assets/index-older.js" })).toBe("reload");
  });
});
