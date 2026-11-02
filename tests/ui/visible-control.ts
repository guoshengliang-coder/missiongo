import { expect, type Locator } from "@playwright/test";

/** A 44px bounding box is insufficient if an ancestor clips half of it. */
export async function expectUsableControl(control: Locator, touch = true) {
  await expect(control).toBeVisible();
  const measurement = await control.evaluate(node => {
    const box = node.getBoundingClientRect();
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), area = parent.getBoundingClientRect();
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, area.left); right = Math.min(right, area.right); }
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, area.top); bottom = Math.min(bottom, area.bottom); }
      // A modal dialog is in the top layer; ancestors outside it cannot clip its controls.
      if (parent.matches("dialog:modal")) break;
    }
    return { width: box.width, height: box.height, clipped: Math.max(0, left - box.left, top - box.top, box.right - right, box.bottom - bottom) };
  });
  expect(measurement.clipped, "control must be fully visible inside viewport and clipping ancestors").toBeLessThanOrEqual(1);
  if (touch) {
    expect(measurement.width).toBeGreaterThanOrEqual(44);
    expect(measurement.height).toBeGreaterThanOrEqual(44);
  }
}
