/* Binder service worker: the app opens from the cache with no connection,
   and a fresh copy is fetched in the background for next launch.
   Bump VERSION whenever any app file changes. Only caches named mtg-*
   are ever cleared, so other apps on the same site keep theirs.
   Fetches skip the browser's HTTP cache (GitHub Pages lets it keep files for
   10 minutes), so an update is picked up on the next launch, not 10 minutes later. */
const PREFIX = "mtg-";
const VERSION = PREFIX + "v1.0.11";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png", "./data/seed.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// Ask the server whether the file changed (a cheap 304 when it hasn't) and keep the answer.
function refresh(request, cacheKey) {
  const fresh = request.mode === "navigate"
    ? new Request(request.url, { cache: "no-cache", credentials: "same-origin" })
    : new Request(request, { cache: "no-cache" });
  return fetch(fresh).then((response) => {
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(VERSION).then((cache) => cache.put(cacheKey || request, copy));
    }
    return response;
  });
}
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The published collection is always fetched fresh, so "Reload published collection" gets the latest; the cache is only the offline fallback.
  if (url.pathname.endsWith("/data/seed.json")) {
    event.respondWith(refresh(request).catch(() => caches.open(VERSION).then((c) => c.match(request, { ignoreSearch: true }))));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(caches.open(VERSION).then((c) => c.match("./index.html")).then((cached) => {
      const network = refresh(request, "./index.html").catch(() => cached);
      return cached || network;
    }));
    return;
  }
  event.respondWith(caches.open(VERSION).then((c) => c.match(request, { ignoreSearch: true })).then((cached) => {
    const network = refresh(request).catch(() => cached);
    return cached || network;
  }));
});

self.addEventListener("message", (event) => { if (event.data === "skipWaiting") self.skipWaiting(); });
