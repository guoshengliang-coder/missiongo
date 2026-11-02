import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "./types.js";
import { object } from "./types.js";
declare const PRODUCT_NAME: string;

export function serverOrigin(input: string): string {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Use an HTTPS server origin (HTTP is allowed only for local development)");
  }
  return url.origin;
}
export class APIError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`MissionGo request failed: HTTP ${status} (${code})`); }
}
export class API {
  constructor(readonly server: string, readonly token?: string, readonly signal?: AbortSignal) { serverOrigin(server); }
  async call(method: string, path: string, body?: unknown, token = this.token, timeout = 40_000): Promise<any> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid API path");
    const signal = this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    const response = await fetch(this.server + path, {
      method, redirect: "error", signal,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: { code?: string } | string };
      throw new APIError(response.status, typeof data.error === "string" ? data.error : data.error?.code ?? "request_failed");
    }
    return response.status === 204 ? undefined : response.json();
  }
  async login(config: Config, name: string, display: (url: string, code: string) => void): Promise<Config> {
    const client = object(await this.call("POST", "/oauth/register", {
      client_name: `${typeof PRODUCT_NAME === "string" ? PRODUCT_NAME : "Headless"} Linux CLI`, grant_types: ["urn:ietf:params:oauth:grant-type:device_code"], token_endpoint_auth_method: "none",
    }));
    const form = async (path: string, body: Record<string, string>) => {
      const response = await fetch(this.server + path, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
      return { ok: response.ok, body: object(await response.json()) };
    };
    const start = await form("/oauth/device_authorization", { client_id: client.client_id, scope: "missiongo:read missiongo:node" });
    const device = start.body;
    if (!start.ok || !device.device_code || !device.user_code || !(device.expires_in > 0 && device.expires_in <= 3600)) throw new Error("Invalid device authorization");
    for (const value of [device.verification_uri, device.verification_uri_complete]) {
      const url = new URL(value); if (url.origin !== this.server || url.username || url.password) throw new Error("Invalid verification origin");
    }
    display(device.verification_uri_complete, device.user_code);
    const deadline = Date.now() + device.expires_in * 1000;
    let interval = Math.max(5, Number(device.interval) || 5);
    while (Date.now() < deadline) {
      await delay(interval * 1000, undefined, this.signal ? { signal: this.signal } : {});
      const poll = await form("/oauth/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: client.client_id, device_code: device.device_code });
      if (poll.ok) {
        if (typeof poll.body.access_token !== "string" || !String(poll.body.scope).split(" ").includes("missiongo:node")) throw new Error("Missing node authorization");
        const node = object(await this.call("POST", "/api/v1/node/register", { installationId: config.installationId, name, hostname: hostname() }, poll.body.access_token));
        if (!node.token || !node.nodeId) throw new Error("Invalid node registration");
        // Only the revocable node credential persists, never the OAuth access token.
        return { ...config, server: this.server, nodeId: node.nodeId, token: node.token, name: node.name ?? name };
      }
      if (poll.body.error === "slow_down") interval += 5;
      else if (poll.body.error !== "authorization_pending") throw new Error(`Device authorization failed: ${poll.body.error}`);
    }
    throw new Error("Device authorization expired; run login again");
  }
}
