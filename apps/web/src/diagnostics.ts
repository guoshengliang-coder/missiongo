export const MAX_DIAGNOSTIC_LOG_BYTES = 256 * 1024;

export function diagnosticLogBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function diagnosticLogFile(value: string, now = new Date()): File | undefined {
  const content = value.trim();
  if (!content) return undefined;
  const timestamp = now.toISOString().replaceAll(":", "-").replace(".", "-");
  return new File([content], `diagnostic-${timestamp}.log`, {
    type: "text/plain;charset=utf-8",
    lastModified: now.getTime(),
  });
}

export function collectWebContext(): Readonly<Record<string, string>> {
  if (typeof window === "undefined" || typeof navigator === "undefined") return {};
  const connection = (navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
    deviceMemory?: number;
  }).connection;
  const context: Record<string, string> = {
    browserUserAgent: navigator.userAgent.slice(0, 2_000),
    browserLanguage: navigator.language,
    browserLanguages: navigator.languages.join(","),
    browserPlatform: navigator.platform,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    pageUrl: window.location.href.slice(0, 2_000),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    screen: `${window.screen.width}x${window.screen.height}`,
    availableScreen: `${window.screen.availWidth}x${window.screen.availHeight}`,
    pixelRatio: String(window.devicePixelRatio),
    online: String(navigator.onLine),
    cookieEnabled: String(navigator.cookieEnabled),
    hardwareConcurrency: String(navigator.hardwareConcurrency),
    maxTouchPoints: String(navigator.maxTouchPoints),
    documentVisibility: document.visibilityState,
  };
  if (document.referrer) context.referrer = document.referrer.slice(0, 2_000);
  if (window.screen.orientation?.type) context.screenOrientation = window.screen.orientation.type;
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (deviceMemory !== undefined) context.deviceMemoryGiB = String(deviceMemory);
  if (connection?.effectiveType) context.networkEffectiveType = connection.effectiveType;
  if (connection?.downlink !== undefined) context.networkDownlinkMbps = String(connection.downlink);
  if (connection?.rtt !== undefined) context.networkRttMs = String(connection.rtt);
  if (connection?.saveData !== undefined) context.networkSaveData = String(connection.saveData);
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (navigation) {
    context.navigationType = navigation.type;
    context.domContentLoadedMs = String(Math.round(navigation.domContentLoadedEventEnd));
    if (navigation.loadEventEnd > 0) context.pageLoadMs = String(Math.round(navigation.loadEventEnd));
    context.pageTransferBytes = String(navigation.transferSize);
  }
  return context;
}
