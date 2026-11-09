import { request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { DispatchStore } from "./dispatch-store.js";
import { TEST_CONSOLE_ACCOUNT } from "./testing-fixtures.js";

it("holds a real HTTP claim-next POST until its idle deadline", async () => {
  const app = buildApp({ databasePath: ":memory:", adminAccount: TEST_CONSOLE_ACCOUNT });
  try {
    const node = new DispatchStore(app.missionGoStore.database).registerNode({
      accountId: TEST_CONSOLE_ACCOUNT.id, installationId: "long-poll-contract", name: "Synthetic node",
    });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const started = performance.now();
    const response = await fetch(`${origin}/api/v1/node/dispatches/claim-next`, {
      method: "POST", headers: { authorization: `Bearer ${node.token}`, "content-type": "application/json" },
      body: JSON.stringify({ waitMs: 2000 }), signal: AbortSignal.timeout(10_000),
    });
    await response.text();
    const elapsed = performance.now() - started;
    expect(response.status).toBe(204);
    // inject's mock request does not reproduce IncomingMessage closing after
    // its body is consumed. A generous lower bound catches that old regression
    // without imposing a machine-speed-dependent upper bound.
    expect(elapsed, `waitMs=2000 returned in ${elapsed.toFixed(1)}ms`).toBeGreaterThanOrEqual(1900);
  } finally { await app.close(); }
});

it("aborts a real HTTP waiter when the client disconnects", async () => {
  const app = buildApp({ databasePath: ":memory:", adminAccount: TEST_CONSOLE_ACCOUNT });
  const original = DispatchStore.prototype.waitForDispatch;
  const entered = Promise.withResolvers<AbortSignal>();
  const exited = Promise.withResolvers<void>();
  const spy = vi.spyOn(DispatchStore.prototype, "waitForDispatch").mockImplementation(async function (id, ms, signal) {
    entered.resolve(signal!);
    await original.call(this, id, ms, signal);
    exited.resolve();
  });
  let client: ReturnType<typeof httpRequest> | undefined;
  try {
    const node = new DispatchStore(app.missionGoStore.database).registerNode({
      accountId: TEST_CONSOLE_ACCOUNT.id, installationId: "disconnect-contract", name: "Synthetic node",
    });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    client = httpRequest(`${origin}/api/v1/node/dispatches/claim-next`, {
      method: "POST", headers: { authorization: `Bearer ${node.token}`, "content-type": "application/json" },
    });
    client.on("error", () => { /* Expected ECONNRESET after intentionally hanging up. */ });
    client.end(JSON.stringify({ waitMs: 25_000 }));
    const deadline = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("HTTP waiter cleanup timed out")), 5000);
      timer.unref();
    });
    const signal = await Promise.race([entered.promise, deadline]);
    expect(signal.aborted).toBe(false);
    client.destroy();
    await Promise.race([exited.promise, deadline]);
    expect(signal.aborted).toBe(true);
  } finally { client?.destroy(); spy.mockRestore(); await app.close(); }
});
