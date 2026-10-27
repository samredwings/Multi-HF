// __BUILD__ is replaced with a content hash by scripts/build.mjs so every release gets a fresh cache.
const CACHE = "multi-hf-static-__BUILD__";
const CORE = ["./", "./index.html", "./src/app.js", "./src/lib/core.js", "./src/styles.css", "./manifest.webmanifest", "./favicon.svg"]
  .map((path) => new URL(path, self.registration.scope).href);
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("multi-hf-") && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()),
));
// Network-first so a new release is picked up immediately; the cache is the offline fallback.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !event.request.url.startsWith(self.registration.scope)) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(event.request, copy)); }
    return response;
  }).catch(() => caches.match(event.request).then((cached) => cached || Response.error())));
});
