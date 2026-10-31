import { describe, expect, it } from "vitest";

import { resizeTextarea } from "./auto-grow-textarea";

/**
 * resizeTextarea only reads value, scrollHeight and offsetHeight and writes
 * style, so a plain object is enough: no layout engine is involved in the
 * decision under test.
 */
function field({ value = "", scrollHeight = 44, offsetHeight = 44 }: {
  value?: string;
  scrollHeight?: number;
  offsetHeight?: number;
} = {}): HTMLTextAreaElement {
  return {
    value,
    scrollHeight,
    offsetHeight,
    style: { height: "66px", overflowY: "visible" as string },
  } as unknown as HTMLTextAreaElement;
}

describe("an auto-growing textarea", () => {
  it("leaves an empty field to its rows and CSS instead of measuring the placeholder (AND-348)", () => {
    // A narrow composer wraps the placeholder to two lines; scrollHeight counts
    // them and would open the field two lines tall.
    const textarea = field({ value: "", scrollHeight: 66 });
    resizeTextarea(textarea);
    expect(textarea.style.height).toBe("");
    expect(textarea.style.overflowY).toBe("hidden");
  });

  it("grows to the content once there is text", () => {
    const textarea = field({ value: "第一行\n第二行\n第三行", scrollHeight: 90 });
    resizeTextarea(textarea);
    expect(textarea.style.height).toBe("90px");
    expect(textarea.style.overflowY).toBe("hidden");
  });

  it("stops at the maximum height and scrolls the rest", () => {
    const textarea = field({ value: "x\n".repeat(40), scrollHeight: 900 });
    resizeTextarea(textarea, 240);
    expect(textarea.style.height).toBe("240px");
    expect(textarea.style.overflowY).toBe("auto");
  });
});
