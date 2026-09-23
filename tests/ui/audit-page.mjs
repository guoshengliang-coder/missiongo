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

export const AUDIT_SOURCE = String.raw`(() => {
  const parse = (value) => {
    const match = value.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const luminance = ({ r, g, b }) => {
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const contrast = (a, b) => {
    const x = luminance(a);
    const y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const pageBackground = parse(getComputedStyle(document.body).backgroundColor)
    || parse(getComputedStyle(document.documentElement).backgroundColor)
    || { r: 255, g: 255, b: 255, a: 1 };
  const backgroundBehind = (element) => {
    const layers = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const colour = parse(getComputedStyle(node).backgroundColor);
      if (colour && colour.a > 0) {
        layers.push(colour);
        if (colour.a >= 1) break;
      }
    }
    let base = { ...pageBackground, a: 1 };
    for (let i = layers.length - 1; i >= 0; i -= 1) base = over(layers[i], base);
    return base;
  };
  const onScreen = (element) => {
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
      if (foreground) {
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
    }
    // A surface that stays light in the dark theme: a literal colour that only
    // ever held in one theme. B1 was exactly this -- a beige status bar with
    // dark chips on it, so every text ratio still passed while the bar glared.
    const own = parse(style.backgroundColor);
    if (own && own.a >= 0.3 && !element.closest("img, video, canvas, svg")) {
      const box = element.getBoundingClientRect();
      if (box.width * box.height >= 400) {
        const painted = over(own, { ...pageBackground, a: 1 });
        if (luminance(painted) > 0.3) {
          surfaces.push({ where: describe(element), colour: style.backgroundColor, width: Math.round(box.width), height: Math.round(box.height) });
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
    brand: getComputedStyle(document.documentElement).getPropertyValue("--mint").trim(),
  };
})()`;
