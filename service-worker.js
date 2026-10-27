const CACHE = "multi-hf-static-v1";
const CORE = ["/", "/index.html", "/src/app.js", "/src/lib/core.js", "/src/styles.css", "/manifest.webmanifest", "/favicon.svg"];
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE))));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("multi-hf-") && key !== CACHE).map((key) => caches.delete(key))))));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok && (url.pathname === "/" || url.pathname.startsWith("/src/") || url.pathname.endsWith(".svg") || url.pathname.endsWith(".webmanifest"))) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
});
