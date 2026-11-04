// The measurements, as a string of source that runs inside the page.
//
// This is what UI-05 and UI-06 checked by hand once: walk every visible text
// node, take the colour it actually renders in and the background it actually
// sits on, and compute the ratio -- rather than trusting the token it was
// supposed to use. Kept as source text so Playwright can evaluate it and the
// browser console can paste it.
//
// Reported, not asserted: the spec decides what is a failure, so one place
// holds the thresholds.

import { COLOUR_TOOLS_SOURCE } from "./audit-colour.mjs";

export const AUDIT_SOURCE = String.raw`(() => {
  const { parse, over, luminance, contrast, backgroundBehind, same } = ${COLOUR_TOOLS_SOURCE};
  const brand = getComputedStyle(document.documentElement).getPropertyValue("--mint").trim();
  const brandColour = brand ? parse(brand) : null;
  const onScreen = (element) => {
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    if (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) return false;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || Number(style.opacity) <= 0.05) return false;
    // A closed menu still lays its items out -- the popover is positioned, not
    // display:none -- but nobody can read or press them. Same for anything the
    // page has marked inert or hidden from assistive technology.
    const menu = element.closest("details");
    if (menu && !menu.open && !element.closest("summary")) return false;
    return !element.closest("[inert], [aria-hidden=true]");
  };
  const describe = (element) => {
    const classes = typeof element.className === "string" && element.className.trim()
      ? "." + element.className.trim().split(/\s+/).slice(0, 2).join(".")
      : "";
    return element.tagName.toLowerCase() + classes;
  };

  const text = [];
  const targets = [];
  const surfaces = [];
  for (const element of document.querySelectorAll("body *")) {
    if (!onScreen(element)) continue;
    const style = getComputedStyle(element);
    const owns = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
    if (owns && !element.closest("canvas, img, video, svg")) {
      const foreground = parse(style.color);
      const background = backgroundBehind(element);
      text.push({
        where: describe(element),
        sample: element.textContent.trim().slice(0, 30),
        fontSize: parseFloat(style.fontSize),
        fontWeight: Number(style.fontWeight) || 400,
        contrast: contrast(over(foreground, background), background),
        colour: style.color,
        monospace: /mono/i.test(style.fontFamily),
      });
    }
    // A surface that stays light in the dark theme: a literal colour that only
    // ever held in one theme. B1 was exactly this -- a beige status bar with
    // dark chips on it, so every text ratio still passed while the bar glared.
    const own = parse(style.backgroundColor);
    if (own.a >= 0.3 && !element.closest("img, video, canvas, svg")) {
      const box = element.getBoundingClientRect();
      if (box.width * box.height >= 400) {
        const painted = backgroundBehind(element);
        if (luminance(painted) > 0.3) {
          surfaces.push({ where: describe(element), colour: style.backgroundColor, brand: Boolean(brandColour && same(own, brandColour)), width: Math.round(box.width), height: Math.round(box.height) });
        }
      }
    }
    if (element.matches("button, a[href], input, select, textarea, summary, [role=button], [role=tab]")) {
      // A checkbox or radio inside a <label> is pressed through the label, which
      // is the target size that counts (WCAG 2.5.8).
      const hit = element.matches("input") && element.closest("label") ? element.closest("label") : element;
      const box = hit.getBoundingClientRect();
      targets.push({ where: describe(element), label: (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 30), width: Math.round(box.width), height: Math.round(box.height) });
    }
  }
  return {
    appearance: document.documentElement.getAttribute("data-appearance"),
    coarsePointer: matchMedia("(pointer: coarse)").matches,
    horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    text,
    targets,
    surfaces,
    brand,
  };
})()`;
