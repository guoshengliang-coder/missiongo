import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";

// Applied before importing server modules. Data-bearing workers have no remote
// connection capability; SSH transfer happens in their separate preparation process.
export function restrictToLoopback() {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const input = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof input === "object" ? input.host : args[1];
    if (host !== "127.0.0.1" && host !== "::1") throw new Error("Non-loopback network blocked");
    return connect.apply(this, args);
  };
  tls.connect = () => { throw new Error("TLS blocked in backup smoke"); };
  dgram.createSocket = () => { throw new Error("Datagrams blocked in backup smoke"); };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Remote fetch blocked in backup smoke");
    return originalFetch(input, { ...options, redirect: "error" });
  };
  syncBuiltinESMExports();
}
