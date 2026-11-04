import { describe, expect, it } from "vitest";
import { productMetadata } from "./branding";
import { translate } from "./i18n";

describe("product branding", () => {
  it.each([
    ["zh-CN", "一站式AI交付平台", "/manifest.webmanifest", "/og.png"],
    ["en", "All-in-one AI delivery platform", "/manifest-en.webmanifest", "/og-en.png"],
  ] as const)("keeps %s interface, title, description and install/share metadata together", (locale, tagline, manifest, socialImage) => {
    expect(translate(locale, "productTagline")).toBe(tagline);
    expect(productMetadata(locale)).toEqual({ title: `MissionGo · ${tagline}`, description: `MissionGo — ${tagline}`, manifest, socialImage });
  });
});
