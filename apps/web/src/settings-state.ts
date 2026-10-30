/** Settings have their own URLs; workspace query parameters survive the round trip. */
export const SETTINGS_DEPTH = "missiongo:settings-depth";
export const SETTINGS_INDEX = "missiongo:settings-index";
export const PRODUCT_SETTINGS = ["product", "components", "builders", "artifacts", "tokens", "notifications"] as const;
export type ProductSettingsSection = typeof PRODUCT_SETTINGS[number];
export type SettingsSection = ProductSettingsSection | "index" | "profile" | "display" | "agent" | "connections" | "devices" | "dispatch" | "products" | "overview" | "access" | "accounts" | "project-admins" | "ai" | "dingtalk" | "new-product";
export interface SettingsRoute { section: SettingsSection; productId?: string | undefined; nodeId?: string | undefined; componentId?: string | undefined; accountId?: string | undefined; filterProductId?: string | undefined }
export function settingsRoute(url = new URL(window.location.href)): SettingsRoute | null {
  if (!/^\/settings(?:\/|$)/.test(url.pathname)) return null;
  try {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[1] === "products") {
      if (parts[2] === "new") return { section: "new-product" };
      if (!parts[2]) return { section: "products" };
      if (parts[3] === "access") return { section: "access", productId: parts[2] };
      const section = PRODUCT_SETTINGS.find(value => value === parts[3]);
      if (section) return { section, productId: parts[2], ...(section === "components" && parts[4] ? { componentId: parts[4] } : {}) };
      if (!parts[3]) return { section: "overview", productId: parts[2] };
    }
    if (parts[1] === "agent") {
      const section = ["connections", "devices", "dispatch"].find(value => value === parts[2]) as "connections" | "devices" | "dispatch" | undefined;
      return section ? { section, ...(section === "devices" && parts[3] ? { nodeId: parts[3] } : {}) } : { section: "agent" };
    }
    if (parts[1] === "permissions" && parts[2]) return { section: "access", productId: parts[2] };
    if (parts[1] === "admin") {
      if (parts[2] === "dingtalk") return {section:"dingtalk"};
      if (parts[2] === "project-administrators") return {section:"project-admins",...(parts[3] ? {productId:parts[3]} : {})};
      if (parts[2] === "models" || parts[2] === "ai") return { section: "ai" };
      if (parts[2] === "accounts") return { section: "accounts", ...(parts[3] ? { accountId: parts[3] } : {}), ...(url.searchParams.get("settingsProduct") ? { filterProductId: url.searchParams.get("settingsProduct")! } : {}) };
    }
    // Existing bookmarks continue to open their corresponding detail page.
    const section = ["profile", "display", "connections", "devices", "dispatch"].find(value => value === parts[1]) as SettingsSection | undefined;
    return { section: section ?? "index" };
  } catch { return { section: "index" }; }
}
export function settingsUrl(route: SettingsRoute, url = new URL(window.location.href)): string {
  const next = new URL(url); const encode = encodeURIComponent;
  next.searchParams.delete("settingsProduct");
  if (route.filterProductId) next.searchParams.set("settingsProduct", route.filterProductId);
  next.pathname = route.section === "index" ? "/settings"
    : route.section === "new-product" ? "/settings/products/new"
    : route.section === "products" ? "/settings/products"
    : route.section === "access" ? `/settings/permissions/${encode(route.productId ?? "")}`
    : route.section === "accounts" ? `/settings/admin/accounts${route.accountId ? `/${encode(route.accountId)}` : ""}`
    : route.section === "ai" ? "/settings/admin/models"
    : route.section === "dingtalk" ? "/settings/admin/dingtalk"
    : route.section === "project-admins" ? `/settings/admin/project-administrators${route.productId ? `/${encode(route.productId)}` : ""}`
    : route.section === "agent" ? "/settings/agent"
    : ["connections", "devices", "dispatch"].includes(route.section) ? `/settings/agent/${route.section}${route.nodeId ? `/${encode(route.nodeId)}` : ""}`
    : route.productId ? `/settings/products/${encode(route.productId)}${route.section === "overview" ? "" : `/${route.section}`}${route.componentId ? `/${encode(route.componentId)}` : ""}`
    : `/settings/${route.section}`;
  return `${next.pathname}${next.search}${next.hash}`;
}
export function settingsExitUrl(url = new URL(window.location.href)): string {
  const next = new URL(url); next.pathname = "/"; next.searchParams.delete("settingsProduct");
  return `${next.pathname}${next.search}${next.hash}`;
}
