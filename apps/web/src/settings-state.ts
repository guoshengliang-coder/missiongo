/** Settings have their own URLs; workspace query parameters survive the round trip. */
export const SETTINGS_DEPTH = "missiongo:settings-depth";
export const SETTINGS_INDEX = "missiongo:settings-index";
export const PRODUCT_SETTINGS = ["product", "components", "artifacts", "tokens", "access"] as const;
export type ProductSettingsSection = typeof PRODUCT_SETTINGS[number];
export type SettingsSection = ProductSettingsSection | "index" | "profile" | "display" | "connections" | "devices" | "dispatch" | "accounts" | "ai" | "new-product";
export interface SettingsRoute { section: SettingsSection; productId?: string }
const PERSONAL = ["profile", "display", "connections", "devices", "dispatch"] as const;
export function settingsRoute(url = new URL(window.location.href)): SettingsRoute | null {
  if (!/^\/settings(?:\/|$)/.test(url.pathname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[1] === "products") {
    if (parts[2] === "new") return { section: "new-product" };
    const section = PRODUCT_SETTINGS.find(value => value === parts[3]);
    if (section && parts[2]) {
      try { return { section, productId: decodeURIComponent(parts[2]) }; } catch { return { section: "index" }; }
    }
  }
  if (parts[1] === "admin" && (parts[2] === "accounts" || parts[2] === "ai")) return { section: parts[2] };
  const personal = PERSONAL.find(value => value === parts[1]);
  return { section: personal ?? "index" };
}
export function settingsUrl(route: SettingsRoute, url = new URL(window.location.href)): string {
  const next = new URL(url);
  next.pathname = route.section === "index" ? "/settings"
    : route.section === "new-product" ? "/settings/products/new"
    : route.section === "accounts" || route.section === "ai" ? `/settings/admin/${route.section}`
    : route.productId ? `/settings/products/${encodeURIComponent(route.productId)}/${route.section}` : `/settings/${route.section}`;
  return `${next.pathname}${next.search}${next.hash}`;
}
export function settingsExitUrl(url = new URL(window.location.href)): string {
  const next = new URL(url); next.pathname = "/";
  return `${next.pathname}${next.search}${next.hash}`;
}
