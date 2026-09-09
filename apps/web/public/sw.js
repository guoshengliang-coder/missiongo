// Bumped whenever the caching behaviour changes: `activate` deletes every cache
// that is not this one, which is also how a client with a broken cache recovers.
//
// v4 is that recovery, for AND-35. This file is the only thing a browser checks
// to decide whether to reinstall, and it is byte-identical from build to build,
// so a client that cached a shell before v4 kept serving it indefinitely and had
// no way out. Editing this file at all is what re-runs install; the bump is what
// throws the poisoned cache away.
const CACHE_NAME = "missiongo-shell-v4";
const SHELL = ["/", "/icon.svg", "/manifest.webmanifest"];

// A Response body can only be read once, and `caches.open()` is async: cloning
// inside its `.then` runs after the body has already gone to the page, so the
// clone throws. Every put has to take its copy synchronously, before the
// response is handed over.
function cacheCopy(event, request, response) {
  if (!response.ok) return response;
  const copy = response.clone();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined));
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/mcp") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      // The document is `no-store`, so this used to be a full network round trip
      // on every single launch -- 142ms measured against production even with
      // every asset already cached. Serve the cached copy and refresh it behind
      // the request instead: the next launch gets the new one.
      //
      // Only ever a *complete* shell. The cached document names hashed assets,
      // and a deploy removes the old ones from the server, so a document whose
      // scripts now 404 renders nothing at all. That check guarded the offline
      // path before; serving from cache while online makes it load-bearing.
      const cached = (await caches.match(request)) || (await caches.match("/"));
      if (cached && await shellIsComplete(cached.clone())) {
        event.waitUntil((async () => {
          try {
            const fresh = await fetch(request);
            if (fresh.ok) await putDocument(request, fresh);
          } catch {
            // Offline. The copy just served is still the right answer.
          }
        })());
        return cached;
      }

      try {
        const fresh = await fetch(request);
        if (fresh.ok) event.waitUntil(putDocument(request, fresh.clone()));
        return fresh;
      } catch {
        return cached && (await shellIsComplete(cached.clone())) ? cached : Response.error();
      }
    })());
    return;
  }

  if (["script", "style", "image", "font"].includes(request.destination)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      // A hashed asset that is not there means the document naming it came from
      // a build this server has already replaced. Nothing can be done for the
      // page that asked -- the name it holds is the name that is gone -- but the
      // cached shell must stop handing the same dead names to the next visit,
      // so drop the documents and let that one go to the network. This is what
      // makes the reload the error boundary offers actually fix anything.
      if (response.status === 404 && url.pathname.startsWith("/assets/")) {
        event.waitUntil(dropCachedDocuments());
      }
      return cacheCopy(event, request, response);
    })());
  }
});

/**
 * Store a freshly fetched document under both the URL that was asked for and
 * `/`.
 *
 * `/` is the fallback every navigation lands on when its own URL is not an exact
 * cache hit, and the console's URL always carries a query -- product, status,
 * type, search -- so that fallback is the common path, not the rare one. It used
 * to be written once at install and never again, which left it pinned to
 * whichever build happened to be live the first time this browser opened the
 * site. Every route serves the same index.html, so the copy fetched for
 * `/?product=X` is the right thing to store under `/` as well.
 */
async function putDocument(request, response) {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all([cache.put(request, response.clone()), cache.put("/", response.clone())]);
}

/** Forget every cached document, keeping the hashed assets, which are still valid for whoever names them. */
async function dropCachedDocuments() {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((key) => key.mode === "navigate" || new URL(key.url).pathname === "/")
      .map((key) => cache.delete(key)),
  );
}

/** True when every hashed asset the cached document references is cached as well. */
async function shellIsComplete(document) {
  try {
    const html = await document.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
    const cache = await caches.open(CACHE_NAME);
    const found = await Promise.all(assets.map((asset) => cache.match(asset)));
    return found.every(Boolean);
  } catch {
    return false;
  }
}
