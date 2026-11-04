// This factory is serialized into the page; keep it independent of module scope.
export function createColourTools() {
  const colours = new Map();
  const backgrounds = new WeakMap();
  let context;
  let canvasBackground;
  const clamp = (value, max) => Math.max(0, Math.min(max, value));
  const parse = (value) => {
    if (colours.has(value)) return colours.get(value);
    const fail = () => { throw new Error(`UI audit cannot resolve CSS colour: ${value}`); };
    if (!CSS.supports("color", value)) return fail();
    // Preserve floating-point precision for the common computed RGB form.
    const match = value.match(/^rgba?\(([^)]+)\)$/i);
    const parts = match?.[1].split(/[\s,/]+/).filter(Boolean);
    let colour;
    if (parts && (parts.length === 3 || parts.length === 4)) {
      const numbers = parts.map((part, index) => {
        const max = index < 3 ? 255 : 1;
        return clamp(part.endsWith("%") ? Number(part.slice(0, -1)) * max / 100 : Number(part), max);
      });
      if (numbers.every(Number.isFinite)) {
        colour = { r: numbers[0], g: numbers[1], b: numbers[2], a: numbers[3] ?? 1 };
      }
    }
    if (!colour) {
      // Let the same browser that paints the CSS resolve modern colour spaces
      // and convert them into sRGB for the contrast calculation. Never silently
      // omit text when a colour cannot be measured.
      if (!context) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        context = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
      }
      if (!context) return fail();
      context.fillStyle = "#010203";
      context.fillStyle = value;
      const first = context.fillStyle;
      context.fillStyle = "#040506";
      context.fillStyle = value;
      // Canvas ignores unsupported fillStyle values. Two different sentinels
      // distinguish that from a valid colour equal to either sentinel.
      if (context.fillStyle !== first) return fail();
      context.clearRect(0, 0, 1, 1);
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1, { colorSpace: "srgb" }).data;
      colour = { r, g, b, a: alpha / 255 };
    }
    colours.set(value, colour);
    return colour;
  };
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);
    const channel = (key) => a ? (top[key] * top.a + bottom[key] * bottom.a * (1 - top.a)) / a : 0;
    return { r: channel("r"), g: channel("g"), b: channel("b"), a };
  };
  const luminance = ({ r, g, b }) => {
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const contrast = (a, b) => {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const backgroundBehind = (element) => {
    if (!element) {
      if (!canvasBackground) {
        // Canvas is the browser's document background, including color-scheme
        // and system colours. Read its computed value without painting a probe.
        const probe = document.createElement("span");
        probe.style.cssText = "display: none !important; color: Canvas !important; color-scheme: inherit !important";
        document.documentElement.append(probe);
        try { canvasBackground = parse(getComputedStyle(probe).color); }
        finally { probe.remove(); }
      }
      return canvasBackground;
    }
    if (backgrounds.has(element)) return backgrounds.get(element);
    const own = parse(getComputedStyle(element).backgroundColor);
    const painted = own.a === 1 ? own : over(own, backgroundBehind(element.parentElement));
    backgrounds.set(element, painted);
    return painted;
  };
  // Half an 8-bit step allows the canvas conversion's rounding, not a visually
  // similar colour. Alpha must match too, so translucent mint is not exempt.
  const same = (a, b) => ["r", "g", "b"].every(key => Math.abs(a[key] - b[key]) <= 0.51)
    && Math.abs(a.a - b.a) <= 0.51 / 255;
  return { parse, over, luminance, contrast, backgroundBehind, same };
}

export const COLOUR_TOOLS_SOURCE = `(${createColourTools.toString()})()`;
