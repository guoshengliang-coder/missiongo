import { describe, expect, it } from "vitest";

import { browserName, environmentFields } from "./environment-summary";

// A web capture stores nothing in appVersion, deviceModel or osVersion, so the
// list row used to read "no version or device details" beside a detail page
// showing twenty metadata fields. The browser is the closest thing a browser
// report has to a device.
describe("browserName", () => {
  it("names the browser and its major version", () => {
    expect(browserName("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36"))
      .toBe("Chrome 152");
    expect(browserName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"))
      .toBe("Safari 17");
    expect(browserName("Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0"))
      .toBe("Firefox 126");
  });

  it("picks the real browser when several claim the same engine", () => {
    // Edge and Chrome both say "Chrome"; Chrome also says "Safari".
    expect(browserName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0"))
      .toBe("Edge 124");
    expect(browserName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"))
      .toBe("Chrome 124");
  });

  it("gives up rather than guessing on something it does not recognise", () => {
    expect(browserName("MissionGoAndroid/0.1.7")).toBeUndefined();
    expect(browserName("")).toBeUndefined();
  });
});

describe("environmentFields", () => {
  const t = ((key: string) => `t:${key}`) as Parameters<typeof environmentFields>[1];

  it("puts the glance up front and folds the rest of a web capture away", () => {
    const { primary, more } = environmentFields({
      platform: "web",
      metadata: {
        browserUserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
        viewport: "1738x878",
        timeZone: "Asia/Shanghai",
        pageUrl: "https://example.test/",
      },
    }, t);
    expect(primary.map((field) => [field.key, field.value])).toEqual([
      ["platform", "t:web"],
      ["browser", "Chrome 152"],
      ["viewport", "1738x878"],
    ]);
    // The raw user agent is still reachable; the viewport is not repeated.
    expect(more.map((field) => field.key)).toEqual(["metadata:browserUserAgent", "metadata:timeZone", "metadata:pageUrl"]);
  });

  it("shows an app build's version, build, system and device, and nothing that was not captured", () => {
    const { primary, more } = environmentFields({
      platform: "android",
      appVersion: "0.1.12",
      buildNumber: "112",
      osVersion: "Android 16",
      deviceModel: "MBH-AN10",
      sourceRevision: "9ab5660",
    }, t);
    expect(primary.map((field) => field.key)).toEqual(["platform", "appVersion", "buildNumber", "osVersion", "deviceModel"]);
    expect(more).toEqual([{ key: "sourceRevision", label: "sourceRevision", value: "9ab5660", code: true }]);
  });

  it("has nothing to show without a capture", () => {
    expect(environmentFields(undefined, t)).toEqual({ primary: [], more: [] });
  });
});
