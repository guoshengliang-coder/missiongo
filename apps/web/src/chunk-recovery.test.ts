import { describe, expect, it } from "vitest";

import { isChunkLoadError } from "./chunk-recovery";

/**
 * The real messages, with a real chunk name in them. The URL is the part that
 * changes on every build, so the match has to survive it.
 */
const CHROMIUM = "Failed to fetch dynamically imported module: https://missiongo.example/assets/ImageAnnotator-ejbzoz0r.js";
const FIREFOX = "error loading dynamically imported module: https://missiongo.example/assets/ImageAnnotator-ejbzoz0r.js";
const SAFARI = "Importing a module script failed.";
const VITE_CSS = "Unable to preload CSS for /assets/index-DWRytWJO.css";

describe("chunk load errors", () => {
  it("recognises what each engine says about an import it could not fetch", () => {
    for (const message of [CHROMIUM, FIREFOX, SAFARI, VITE_CSS]) {
      expect(isChunkLoadError(new Error(message))).toBe(true);
    }
  });

  it("matches whatever case the engine used", () => {
    expect(isChunkLoadError(new Error(CHROMIUM.toUpperCase()))).toBe(true);
    expect(isChunkLoadError(new Error(CHROMIUM.toLowerCase()))).toBe(true);
  });

  it("reads a thrown string, which is not an Error but still carries the message", () => {
    expect(isChunkLoadError(CHROMIUM)).toBe(true);
  });

  // The boundary offers a reload for these. Offering one for a plain crash would
  // send people round a loop that reloads into the same broken render.
  it("leaves ordinary render failures alone", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined (reading 'width')"))).toBe(false);
    expect(isChunkLoadError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isChunkLoadError(new Error("The annotated image could not be created."))).toBe(false);
  });

  it("survives being handed something that is not an error at all", () => {
    for (const value of [undefined, null, 0, {}, [], new Error()]) {
      expect(isChunkLoadError(value)).toBe(false);
    }
  });
});
