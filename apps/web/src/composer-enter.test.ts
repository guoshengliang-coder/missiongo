import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { COARSE_POINTER_QUERY, composerEnterAction, type ComposerEnterEvent } from "./composer-enter";

const enter: ComposerEnterEvent = {
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  composing: false,
};

describe("composerEnterAction", () => {
  it("sends a keyboard Enter that has text behind it", () => {
    expect(composerEnterAction(enter, "继续", false)).toEqual({ submit: true, preventDefault: true });
  });

  it("sends nothing when the box is empty, and swallows the key instead of starting a blank line", () => {
    expect(composerEnterAction(enter, "", false)).toEqual({ submit: false, preventDefault: true });
    expect(composerEnterAction(enter, "   \n ", false)).toEqual({ submit: false, preventDefault: true });
  });

  it("leaves Shift+Enter to the browser as a newline", () => {
    expect(composerEnterAction({ ...enter, shiftKey: true }, "第一行", false)).toEqual({ submit: false, preventDefault: false });
  });

  it("does not send on the other modifier combinations either", () => {
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }] as const) {
      expect(composerEnterAction({ ...enter, ...modifier }, "文字", false)).toEqual({ submit: false, preventDefault: false });
    }
  });

  it("never sends the Enter that confirms an input method candidate", () => {
    // Unswallowed: the IME needs the key to commit the word.
    expect(composerEnterAction({ ...enter, composing: true }, "你好", false)).toEqual({ submit: false, preventDefault: false });
  });

  it("keeps Enter as a newline on a touch screen, where there is no Shift to break a line with", () => {
    expect(composerEnterAction(enter, "第一行", true)).toEqual({ submit: false, preventDefault: false });
  });

  it("ignores every other key", () => {
    expect(composerEnterAction({ ...enter, key: "a" }, "文字", false)).toEqual({ submit: false, preventDefault: false });
    expect(composerEnterAction({ ...enter, key: "Escape" }, "文字", false)).toEqual({ submit: false, preventDefault: false });
  });

  it("asks the same pointer feature the touch sizing does", () => {
    expect(COARSE_POINTER_QUERY).toBe("(pointer: coarse)");
  });
});

describe("reply composers", () => {
  const consoleSource = readFileSync(fileURLToPath(new URL("./agent-session-console.tsx", import.meta.url)), "utf8");
  const panelSource = readFileSync(fileURLToPath(new URL("./agent-session-panel.tsx", import.meta.url)), "utf8");

  it("both enable Enter-to-send on their reply box", () => {
    for (const source of [consoleSource, panelSource]) {
      expect(source).toMatch(/<AutoGrowTextarea[\s\S]{0,120}submitOnEnter/);
    }
  });

  it("leaves the long-form textareas on Enter-as-newline", () => {
    const appSource = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
    const reportFields = appSource.match(/<AutoGrowTextarea[\s\S]{0,200}?\/>/g) ?? [];

    expect(reportFields.length).toBeGreaterThan(0);
    for (const field of reportFields) expect(field).not.toContain("submitOnEnter");
  });
});
