// Minimal service worker so the app is installable and survives losing signal.
// No push handling here — notifications come from ntfy's own app, not this worker.
const CACHE_NAME = "flightwatch-v15";

// Precached so the offline state has a shell to render.
const CORE_ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/manifest.json",
  "/icon.svg",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
];

// The shell is served network-first: a driver acting on a stale gate number is
// the failure this app exists to prevent, and cache-first meant a missed cache
// bump silently kept running old code on installed PWAs. Everything else stays
// cache-first, since those assets only change when their name does.
const SHELL = new Set(["/", "/index.html", "/app.js"]);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Let the Worker API and cross-origin requests (fonts) go straight to the network;
  // the app handles its own offline fallback for data.
  if (url.origin !== self.location.origin) return;

  const isShell = request.mode === "navigate" || SHELL.has(url.pathname);

  if (isShell) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/index.html")))
    );
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
