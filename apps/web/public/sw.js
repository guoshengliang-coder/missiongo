// Bumped whenever the caching behaviour changes: `activate` deletes every cache
// that is not this one, which is also how a client with a broken cache recovers.
const CACHE_NAME = "missiongo-shell-v3";
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
            if (fresh.ok) (await caches.open(CACHE_NAME)).put(request, fresh.clone());
          } catch {
            // Offline. The copy just served is still the right answer.
          }
        })());
        return cached;
      }

      try {
        return cacheCopy(event, request, await fetch(request));
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
      return cacheCopy(event, request, await fetch(request));
    })());
  }
});

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
