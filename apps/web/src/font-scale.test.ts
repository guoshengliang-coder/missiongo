import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyConsoleFontScale,
  applyFontScale,
  CONSOLE_FONT_SCALE_STORAGE_KEY,
  DEFAULT_FONT_SCALE,
  FONT_SCALE_STORAGE_KEY,
  isFontScale,
  parseFontScale,
  readStoredConsoleFontScale,
  readStoredFontScale,
  storeConsoleFontScale,
  storeFontScale,
} from "./font-scale";

function stubDocument(): Record<string, string> {
  const dataset: Record<string, string> = {};
  vi.stubGlobal("document", { documentElement: { dataset } });
  return dataset;
}

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe("the console's type size choice", () => {
  it("recognises only the three named sizes", () => {
    expect(isFontScale("small")).toBe(true);
    expect(isFontScale("medium")).toBe(true);
    expect(isFontScale("large")).toBe(true);
    expect(isFontScale("huge")).toBe(false);
    expect(isFontScale("")).toBe(false);
    expect(isFontScale(null)).toBe(false);
    expect(isFontScale(115)).toBe(false);
  });

  it("reads a missing or junk value as medium, the base scale", () => {
    expect(DEFAULT_FONT_SCALE).toBe("medium");
    expect(parseFontScale(undefined)).toBe("medium");
    expect(parseFontScale(null)).toBe("medium");
    expect(parseFontScale("huge")).toBe("medium");
    expect(parseFontScale("large")).toBe("large");
  });

  it("puts the choice on the root element, where styles.css selects on it", () => {
    const dataset = stubDocument();
    applyFontScale("large");
    expect(dataset.fontScale).toBe("large");
    applyFontScale("medium");
    expect(dataset.fontScale).toBe("medium");
  });
});

describe("the cached type size", () => {
  it("round-trips through storage", () => {
    const store = stubStorage();
    storeFontScale("small");
    expect(store.get(FONT_SCALE_STORAGE_KEY)).toBe("small");
    expect(readStoredFontScale()).toBe("small");
  });

  it("falls back to medium for junk, and when storage is unreadable", () => {
    stubStorage({ [FONT_SCALE_STORAGE_KEY]: "huge" });
    expect(readStoredFontScale()).toBe("medium");

    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    expect(readStoredFontScale()).toBe("medium");
    // Writing to a blocked store must not throw: the server holds the real value.
    expect(() => storeFontScale("large")).not.toThrow();
  });
});

describe("the Agent console chat body's own type size (AND-254)", () => {
  it("puts the choice on its own root attribute, apart from the console-wide one", () => {
    const dataset = stubDocument();
    applyFontScale("large");
    applyConsoleFontScale("small");
    expect(dataset.fontScale).toBe("large");
    expect(dataset.consoleFontScale).toBe("small");
    applyConsoleFontScale("medium");
    expect(dataset.consoleFontScale).toBe("medium");
  });

  it("keeps its cached copy apart from the console-wide one", () => {
    const store = stubStorage();
    storeFontScale("large");
    storeConsoleFontScale("small");
    expect(store.get(FONT_SCALE_STORAGE_KEY)).toBe("large");
    expect(store.get(CONSOLE_FONT_SCALE_STORAGE_KEY)).toBe("small");
    // Two settings, so reading one never reports the other.
    expect(readStoredFontScale()).toBe("large");
    expect(readStoredConsoleFontScale()).toBe("small");
  });

  it("falls back to medium for junk, and when storage is unreadable", () => {
    stubStorage({ [CONSOLE_FONT_SCALE_STORAGE_KEY]: "huge" });
    expect(readStoredConsoleFontScale()).toBe("medium");

    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    expect(readStoredConsoleFontScale()).toBe("medium");
    expect(() => storeConsoleFontScale("large")).not.toThrow();
  });
});
