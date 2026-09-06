import type { useI18n } from "./i18n";
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
