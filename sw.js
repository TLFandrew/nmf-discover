// NightMarket.fun Passport — service worker
//
// GOAL: keep the app usable when the park's cell signal drops in and out.
//
// STRATEGY: network-first for everything the app serves. Online visitors always
// get the latest deploy (no stale-cache surprises while you're still updating
// the app), and a cached copy is served ONLY as an offline fallback. The AI and
// telemetry endpoints under /api/ are never cached, so live features stay live.
//
// This file must sit at the site root (served at /sw.js) so its scope covers the
// whole app. No build step, no dependencies.

const CACHE = "nmf-passport-v1";
const SHELL = ["/", "/index.html"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // only GETs are cacheable
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // ignore cross-origin (fonts/CDNs etc.)
  if (url.pathname.startsWith("/api/")) return; // never cache AI search / translation / telemetry

  // Network-first: fresh when online, cached copy when the network fails.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches
          .match(req)
          .then((hit) => hit || caches.match("/index.html") || caches.match("/"))
      )
  );
});
