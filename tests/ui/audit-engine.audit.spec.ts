import { expect, test } from "@playwright/test";
import { COLOUR_TOOLS_SOURCE } from "./audit-colour.mjs";
import { AUDIT_SOURCE } from "./audit-page.mjs";
import { expectUsableControl, expectUsableControls } from "./visible-control";

interface Measurements {
  text: { sample: string; contrast: number }[];
  surfaces: { where: string; brand: boolean }[];
}

test("batched mandatory controls fail when a later target is missing", async ({ page }) => {
  await page.setContent('<button style="width:48px;height:48px">first</button><button style="width:48px;height:48px">last</button>');
  await expectUsableControls(page.locator("button"), true, { count: 2 });
  await expect(expectUsableControls(page.locator("button"), true, { count: 3, timeout: 50 })).rejects.toThrow(/all required controls must be visible/);
});

test("batched controls check later targets for visibility even without touch sizing", async ({ page }) => {
  await page.setContent('<button style="width:48px;height:48px">first</button><button style="width:48px;height:48px">last</button>');
  const controls = page.locator("button");
  for (const style of ["visibility:hidden", "display:none", "width:0;height:0;padding:0;border:0"]) {
    await controls.last().evaluate((node, value) => { node.setAttribute("style", value); }, style);
    await expect(expectUsableControls(controls, false, { count: 2, timeout: 50 })).rejects.toThrow(/all required controls must be visible/);
  }
  // Playwright visibility deliberately ignores opacity; retain that meaning.
  await controls.last().evaluate(node => { node.setAttribute("style", "width:48px;height:48px;opacity:0"); });
  await expect(controls.last()).toBeVisible();
  await expectUsableControls(controls, true, { count: 2 });
});

test("batched controls remeasure clipping after an ancestor changes", async ({ page }) => {
  await page.setContent('<div style="width:160px;overflow:hidden"><button style="width:48px;height:48px">first</button><button style="width:48px;height:48px">last</button></div>');
  const controls = page.locator("button");
  await expectUsableControls(controls, true, { count: 2 });
  await page.locator("div").evaluate(node => { node.style.width = "30px"; });
  await expect(expectUsableControls(controls, true, { count: 2 })).rejects.toThrow(/control must be fully visible/);
});

test("batched control measurements validate every target and retain the touch-size threshold", async ({ page }) => {
  await page.setContent('<button style="width:48px;height:48px">first</button><button style="width:48px;height:48px">last</button>');
  const controls = page.locator("button:visible");
  expect(await expectUsableControls(controls)).toHaveLength(2);
  await controls.last().evaluate(node => { node.style.width = "30px"; node.style.minWidth = "0"; });
  await expect(expectUsableControls(controls)).rejects.toThrow(/toBeGreaterThanOrEqual/);
  await expectUsableControls(controls, false);
});

test("single and batched control measurements reject clipping ancestors but respect modal top layers", async ({ page }) => {
  await page.setContent('<div style="width:30px;overflow:hidden"><button style="width:48px;height:48px">clipped</button></div>');
  const clipped = page.locator("button");
  await expect(expectUsableControl(clipped)).rejects.toThrow(/control must be fully visible/);
  await expect(expectUsableControls(clipped)).rejects.toThrow(/control must be fully visible/);
  await page.setContent('<div style="width:1px;height:1px;overflow:hidden"><dialog><button style="width:48px;height:48px">modal</button></dialog></div>');
  await page.locator("dialog").evaluate(node => node.showModal());
  await expectUsableControl(page.locator("button"));
  await expectUsableControls(page.locator("button:visible"));
});

for (const colour of [
  "color-mix(in srgb, white 75%, black)",
  "color(srgb 0.75 0.75 0.75)",
  "color(srgb-linear 0.5 0.5 0.5)",
  "color(display-p3 0.75 0.75 0.75)",
  "lab(80% 0 0)", "lch(80% 0 40)", "oklab(80% 0 0)", "oklch(80% 0 40)",
]) {
  test(`includes low-contrast text expressed as ${colour}`, async ({ page }) => {
    await page.setContent(`<style>body { background: white; font: 16px sans-serif; } p { color: ${colour}; }</style><p>low contrast</p>`);
    expect(await page.evaluate(value => CSS.supports("color", value), colour)).toBe(true);
    const result = await page.evaluate(AUDIT_SOURCE) as Measurements;
    const text = result.text.find(row => row.sample === "low contrast");
    expect(text, "a supported CSS colour must never silently disappear from the audit").toBeDefined();
    expect(text!.contrast).toBeGreaterThan(1.2);
    expect(text!.contrast).toBeLessThan(4.5);
  });
}

test("composites modern translucent backgrounds once, over their actual ancestors", async ({ page }) => {
  await page.setContent(`<style>
    body { background: white; font: 16px sans-serif; }
    section { background: color(srgb 0 0 0); }
    p { background: color(srgb 1 1 1 / 0.5); color: rgb(128 128 128); }
  </style><section><p>blended grey</p></section>`);
  const result = await page.evaluate(AUDIT_SOURCE) as Measurements;
  expect(result.text.find(row => row.sample === "blended grey")!.contrast).toBeCloseTo(1, 1);
});

test("uses the default white canvas when html and body are transparent", async ({ page }) => {
  await page.setContent('<style>html, body { background: transparent; } p { color: black; }</style><p>black on canvas</p>');
  const result = await page.evaluate(AUDIT_SOURCE) as Measurements;
  expect(result.text.find(row => row.sample === "black on canvas")!.contrast).toBeCloseTo(21, 5);
});

test("uses the browser's dark canvas when transparent roots opt into dark color-scheme", async ({ page }) => {
  await page.setContent('<style>html { color-scheme: dark; } html, body { background: transparent; } p { color: Canvas; }</style><p>canvas on canvas</p>');
  const result = await page.evaluate(AUDIT_SOURCE) as Measurements;
  expect(result.text.find(row => row.sample === "canvas on canvas")!.contrast).toBeCloseTo(1, 5);
});

test("detects modern light surfaces and identifies the mint exemption by colour, not syntax", async ({ page }) => {
  await page.setContent(`<style>
    :root { --mint: #67e3b4; } body { background: black; }
    .bright, .mint { width: 100px; height: 40px; }
    .bright { background: color(srgb 0.95 0.95 0.95); }
    .mint { background: color(srgb 0.403921569 0.890196078 0.705882353); }
  </style><div class="bright"></div><div class="mint"></div>`);
  const result = await page.evaluate(AUDIT_SOURCE) as Measurements;
  expect(result.surfaces.find(row => row.where === "div.bright")).toMatchObject({ brand: false });
  expect(result.surfaces.find(row => row.where === "div.mint")).toMatchObject({ brand: true });
});

test("fails explicitly if a supported computed colour cannot be converted", async ({ page }) => {
  await page.setContent('<p style="color:color(srgb 0.75 0.75 0.75)">unmeasurable</p>');
  await page.evaluate(() => { HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext; });
  await expect(page.evaluate(AUDIT_SOURCE)).rejects.toThrow(/UI audit cannot resolve CSS colour/);
});

test("does not audit descendants of a fully transparent ancestor", async ({ page }) => {
  await page.setContent('<div style="opacity:0"><p>hidden by ancestor</p></div><p>visible text</p>');
  const result = await page.evaluate(AUDIT_SOURCE) as Measurements;
  expect(result.text.map(row => row.sample)).toEqual(["visible text"]);
});

test("keeps RGB percentage channels and percentage alpha finite and precise", async ({ page }) => {
  const result = await page.evaluate(`(() => {
    const { parse } = ${COLOUR_TOOLS_SOURCE};
    return parse("rgb(100% 50% 0% / 50%)");
  })()`);
  expect(result).toEqual({ r: 255, g: 127.5, b: 0, a: 0.5 });
});

test("rejects invalid colours instead of returning null or NaN", async ({ page }) => {
  await expect(page.evaluate(`(${COLOUR_TOOLS_SOURCE}).parse("not-a-colour")`))
    .rejects.toThrow(/UI audit cannot resolve CSS colour/);
});

test("detects a canvas that silently ignores a supported colour", async ({ page }) => {
  await page.setContent('<p style="color:oklch(80% 0 40)">unmeasurable</p>');
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, "fillStyle")!;
    Object.defineProperty(CanvasRenderingContext2D.prototype, "fillStyle", {
      get: descriptor.get,
      set(value) { if (!String(value).startsWith("oklch(")) descriptor.set!.call(this, value); },
      configurable: true,
    });
  });
  await expect(page.evaluate(AUDIT_SOURCE)).rejects.toThrow(/UI audit cannot resolve CSS colour/);
});

test("composites a translucent body over the canvas only once", async ({ page }) => {
  await page.setContent('<style>html { background: transparent; } body { background: rgb(1 1 1 / 50%); } p { color: rgb(128 128 128); }</style><p>body grey</p>');
  const result = await page.evaluate(AUDIT_SOURCE) as Measurements;
  expect(result.text.find(row => row.sample === "body grey")!.contrast).toBeCloseTo(1, 5);
});
