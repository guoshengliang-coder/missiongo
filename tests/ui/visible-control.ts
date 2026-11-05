import { expect, type Locator } from "@playwright/test";

// Self-contained so Playwright can serialize the whole measurement into one
// browser call, including when a layout matrix checks several controls.
function measureControls(nodes: Element[]) {
  // DOM stays unchanged during this read. Share ancestor measurements only
  // within this call; every new viewport/font scale gets a fresh snapshot.
  const ancestors = new Map<Element, { style: CSSStyleDeclaration; box: DOMRect; modal: boolean }>();
  return nodes.map(node => {
    const box = node.getBoundingClientRect();
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      let layout = ancestors.get(parent);
      if (!layout) {
        layout = { style: getComputedStyle(parent), box: parent.getBoundingClientRect(), modal: parent.matches("dialog:modal") };
        ancestors.set(parent, layout);
      }
      const { style, box: area, modal } = layout;
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, area.left); right = Math.min(right, area.right); }
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, area.top); bottom = Math.min(bottom, area.bottom); }
      // A modal dialog is in the top layer; ancestors outside it cannot clip its controls.
      if (modal) break;
    }
    return { width: box.width, height: box.height, top: box.top, bottom: box.bottom,
      clipped: Math.max(0, left - box.left, top - box.top, box.right - right, box.bottom - bottom) };
  });
}

function expectUsableMeasurement(measurement: ReturnType<typeof measureControls>[number], touch: boolean) {
  expect(measurement.clipped, "control must be fully visible inside viewport and clipping ancestors").toBeLessThanOrEqual(1);
  if (touch) {
    expect(measurement.width).toBeGreaterThanOrEqual(44);
    expect(measurement.height).toBeGreaterThanOrEqual(44);
  }
}

/** A 44px bounding box is insufficient if an ancestor clips half of it. */
export async function expectUsableControl(control: Locator, touch = true) {
  await expect(control).toBeVisible();
  const measurements = await control.evaluateAll(measureControls);
  expect(measurements).toHaveLength(1);
  expectUsableMeasurement(measurements[0], touch);
}

/** Use a visible-only locator for optional controls, or a count for mandatory targets. */
export async function expectUsableControls(controls: Locator, touch = true, options: { count?: number; timeout?: number } = {}) {
  if (options.count === undefined) await expect(controls.first()).toBeVisible({ timeout: options.timeout });
  else await expect(controls.filter({ visible: true }), "all required controls must be visible").toHaveCount(options.count, { timeout: options.timeout });
  const measurements = await controls.evaluateAll(measureControls);
  expect(measurements.length, "at least one visible control must be checked").toBeGreaterThan(0);
  if (options.count !== undefined) expect(measurements, "all required controls must be present").toHaveLength(options.count);
  for (const measurement of measurements) expectUsableMeasurement(measurement, touch);
  return measurements;
}
