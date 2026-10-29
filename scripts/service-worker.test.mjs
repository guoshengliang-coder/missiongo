import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../apps/web/public/sw.js", import.meta.url), "utf8");
const origin = "https://missiongo.test";
const shell = '<script type="module" src="/assets/index-test.js"></script><div id="root">console</div>';
const consent = '<form action="/oauth/authorize"><input name="request" value="synthetic-request"></form>';

// Execute the shipping worker, including its event handlers, against browser-like
// CacheStorage. Bodies are real Responses so consumed-body mistakes also fail.
function worker() {
  const handlers = new Map();
  const stores = new Map();
  const fetched = [];
  let network = async () => new Response(shell);
  let claimed = false;
  let skippedWaiting = false;
  const key = (request) => new URL(typeof request === "string" ? request : request.url, origin).href;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(request) { return entries.get(key(request))?.response.clone(); },
        async put(request, response) {
          entries.set(key(request), { request: typeof request === "string" ? { url: key(request) } : request, response: response.clone() });
        },
        async addAll(paths) {
          for (const path of paths) await this.put(path, new Response(path === "/" ? shell : "asset"));
        },
        async keys() { return [...entries.values()].map((entry) => entry.request); },
        async delete(request) { return entries.delete(key(request)); },
      };
    },
    async match(request) {
      for (const name of stores.keys()) {
        const found = await (await caches.open(name)).match(request);
        if (found) return found;
      }
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  vm.runInNewContext(source, {
    URL, Response, caches,
    fetch: async (request) => { fetched.push(key(request)); return network(request); },
    self: {
      location: { origin },
      addEventListener: (name, handler) => handlers.set(name, handler),
      skipWaiting: async () => { skippedWaiting = true; },
      clients: { claim: async () => { claimed = true; }, matchAll: async () => [] },
    },
  });
  const currentName = vm.runInNewContext(`${source}\nCACHE_NAME`, {
    self: { addEventListener() {} },
  });
  return {
    caches, fetched, currentName,
    setNetwork(handler) { network = handler; },
    get claimed() { return claimed; },
    get skippedWaiting() { return skippedWaiting; },
    async seed(name = currentName, document = shell) {
      const cache = await caches.open(name);
      await cache.put("/", new Response(document));
      await cache.put("/assets/index-test.js", new Response("asset"));
      return cache;
    },
    async dispatch(name, fields = {}) {
      const pending = [];
      let response;
      handlers.get(name)({
        ...fields,
        waitUntil(promise) { pending.push(promise); },
        respondWith(promise) { response = promise; },
      });
      const result = await response;
      // Navigation adds a background refresh while responding.
      for (let index = 0; index < pending.length; index++) await pending[index];
      return result;
    },
    navigate(path, overrides = {}) {
      return this.dispatch("fetch", { request: { method: "GET", mode: "navigate", url: new URL(path, origin).href, ...overrides } });
    },
  };
}

test("authorization and device pages always bypass the worker, regardless of caches or login cookies", async () => {
  for (const seeded of [false, true]) {
    for (const signedIn of [false, true]) {
      const sw = worker();
      if (seeded) await sw.seed();
      for (const path of ["/oauth/authorize?state=first", "/oauth/authorize?state=second", "/oauth/device?user_code=TEST-CODE"]) {
        const response = await sw.navigate(path, { headers: new Headers(signedIn ? { cookie: "session=synthetic" } : {}) });
        assert.equal(response, undefined, `must use browser network: ${path}`);
        assert.equal(await sw.caches.match(path), undefined);
      }
      assert.deepEqual(sw.fetched, []); // No hidden background authorization request either.
      assert.equal(await (await sw.caches.match("/"))?.text(), seeded ? shell : undefined);
    }
  }
});

test("OAuth styles, form submissions and server-owned navigation bypass the cache", async () => {
  const sw = worker();
  await sw.seed();
  for (const path of ["/api/v1/auth/session", "/api", "/mcp", "/mcp/anything", "/oauth", "/.well-known/oauth-authorization-server", "/health", "/downloads/client.zip", "/future-server-route", "/settings-other"]) {
    assert.equal(await sw.navigate(path), undefined, path);
  }
  assert.equal(await sw.navigate("/oauth/login.css", { mode: "cors", destination: "style" }), undefined);
  assert.equal(await sw.navigate("/oauth/authorize", { method: "POST" }), undefined);
  assert.equal(await sw.navigate("https://other.test/"), undefined);
  assert.deepEqual(sw.fetched, []);
});

test("console, settings, feedback and decisions retain complete-shell offline navigation", async () => {
  const sw = worker();
  await sw.seed();
  sw.setNetwork(async () => { throw new Error("offline"); });
  for (const path of ["/", "/index.html", "/?product=test", "/settings", "/settings/profile", "/sdk/feedback", "/sdk/feedback/test", "/managed-decisions/test"]) {
    assert.equal(await (await sw.navigate(path)).text(), shell, path);
  }
});

test("successful non-app HTML never replaces or becomes the cached shell", async () => {
  for (const seeded of [false, true]) {
    const sw = worker();
    if (seeded) await sw.seed();
    sw.setNetwork(async () => new Response(consent, { headers: { "cache-control": "no-store" } }));
    assert.equal(await (await sw.navigate("/?product=test")).text(), seeded ? shell : consent);
    assert.equal(await (await sw.caches.match("/"))?.text(), seeded ? shell : undefined);
    assert.equal(await sw.caches.match("/?product=test"), undefined);
  }
});

test("invalid cached documents are replaced online and never used as offline fallback", async () => {
  const sw = worker();
  await sw.seed(sw.currentName, consent);
  assert.equal(await (await sw.navigate("/")).text(), shell);
  assert.equal(await (await sw.caches.match("/"))?.text(), shell);
  await sw.seed(sw.currentName, consent);
  sw.setNetwork(async () => { throw new Error("offline"); });
  assert.equal((await sw.navigate("/")).type, "error");
});

test("an incomplete shell cannot hide a fresh document or render offline", async () => {
  const sw = worker();
  const cache = await sw.seed();
  await cache.delete("/assets/index-test.js");
  sw.setNetwork(async () => new Response(shell.replace("console", "fresh console")));
  assert.match(await (await sw.navigate("/")).text(), /fresh console/);
  sw.setNetwork(async () => { throw new Error("offline"); });
  assert.equal((await sw.navigate("/")).type, "error");
});

test("installation and activation remove the old poisoned cache and claim existing windows", async () => {
  const sw = worker();
  assert.notEqual(sw.currentName, "missiongo-shell-v4");
  const old = await sw.seed("missiongo-shell-v4", consent);
  await old.put("/oauth/authorize?state=old", new Response(consent));
  // Ignore every old cache even before activate has finished deleting it.
  assert.equal(await (await sw.navigate("/")).text(), shell);
  await sw.dispatch("install");
  assert.equal(sw.skippedWaiting, true);
  await sw.dispatch("activate");
  assert.equal(sw.claimed, true);
  assert.deepEqual(await sw.caches.keys(), [sw.currentName]);
  assert.equal(await sw.caches.match("/oauth/authorize?state=old"), undefined);
  assert.equal(await (await sw.caches.match("/"))?.text(), shell);
  assert.equal(await sw.navigate("/oauth/authorize?state=new"), undefined);
});
