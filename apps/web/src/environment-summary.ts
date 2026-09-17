import type { MessageKey, useI18n } from "./i18n";
import type { WorkItemEnvironment } from "./types";

export function platformName(platform: WorkItemEnvironment["platform"], t: ReturnType<typeof useI18n>["t"]): string {
  if (platform === "android") return t("android");
  if (platform === "macos") return t("macos");
  if (platform === "web") return t("web");
  if (platform === "server") return t("server");
  if (platform === "shared") return t("shared");
  return t("other");
}

/** Browser name and major version from a user-agent string, or undefined. */
export function browserName(userAgent: string): string | undefined {
  // Order matters: Edge and Chrome both claim "Chrome", Chrome claims "Safari".
  const patterns: readonly [string, RegExp][] = [
    ["Edge", /Edg(?:e|A|iOS)?\/(\d+)/],
    ["Firefox", /Firefox\/(\d+)/],
    ["Chrome", /Chrome\/(\d+)/],
    ["Safari", /Version\/(\d+).*Safari/],
  ];
  for (const [name, pattern] of patterns) {
    const match = pattern.exec(userAgent);
    if (match) return `${name} ${match[1]}`;
  }
  return undefined;
}

export function environmentSummary(
  environment: WorkItemEnvironment | undefined,
  hasSourceComponent: boolean,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (!environment) return "";
  const metadata = environment.metadata ?? {};
  const parts = [
    hasSourceComponent ? platformName(environment.platform, t) : undefined,
    environment.appVersion ? `v${environment.appVersion}` : undefined,
    environment.deviceModel,
    environment.osVersion,
    // Web captures carry no version or device, but they do carry a user agent
    // and the size of the window the report was written in.
    environment.metadata?.browserUserAgent ? browserName(metadata.browserUserAgent!) : undefined,
    metadata.viewport,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** One cell of the captured-context grid: a translated label, or a raw metadata key. */
export interface EnvironmentField {
  readonly key: string;
  readonly label: MessageKey | { readonly raw: string };
  readonly value: string;
  readonly code?: boolean;
}

/**
 * The captured context split into what a reader wants at a glance and the rest
 * (AND-65).
 *
 * A web capture alone carries twenty-odd metadata keys, and laying all of them
 * out pushed the timeline a screen further down for fields almost nobody reads.
 * The glance is the platform, the build, the system and the device -- and, for a
 * browser report, the browser and the window size, which are the web's version
 * and device. Everything else stays one click away rather than disappearing.
 *
 * Only captured values make a cell: a field that was never recorded does not
 * take up space saying so. The raw user agent stays in `more`; the glance shows
 * only the browser parsed out of it. The viewport is shown once, at the glance.
 */
export function environmentFields(
  environment: WorkItemEnvironment | undefined,
  t: ReturnType<typeof useI18n>["t"],
): {
  readonly primary: readonly EnvironmentField[];
  readonly more: readonly EnvironmentField[];
} {
  if (!environment) return { primary: [], more: [] };
  const metadata = environment.metadata ?? {};
  const browser = metadata.browserUserAgent ? browserName(metadata.browserUserAgent) : undefined;
  const primary: EnvironmentField[] = [{ key: "platform", label: "platform", value: platformName(environment.platform, t) }];
  if (environment.appVersion) primary.push({ key: "appVersion", label: "version", value: environment.appVersion });
  if (environment.buildNumber) primary.push({ key: "buildNumber", label: "buildNumber", value: environment.buildNumber });
  if (environment.osVersion) primary.push({ key: "osVersion", label: "operatingSystem", value: environment.osVersion });
  if (environment.deviceModel) primary.push({ key: "deviceModel", label: "device", value: environment.deviceModel });
  if (browser) primary.push({ key: "browser", label: "browser", value: browser });
  if (metadata.viewport) primary.push({ key: "viewport", label: "viewport", value: metadata.viewport });

  const more: EnvironmentField[] = [];
  if (environment.sourceRevision) {
    more.push({ key: "sourceRevision", label: "sourceRevision", value: environment.sourceRevision, code: true });
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "viewport") continue;
    more.push({ key: `metadata:${key}`, label: { raw: key }, value });
  }
  return { primary, more };
}
