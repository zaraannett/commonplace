// App-shell cache only — never touches Supabase or the CDN script, so live data
// and realtime sync are unaffected. Network-first: always tries to fetch the latest
// shell files first (this app needs network anyway for Supabase), and only falls
// back to the cached copy if the network fails — so a code update always shows up
// on the very next load instead of needing two reloads like a stale-while-revalidate
// strategy would.
//
// The fetch() below explicitly bypasses the browser's own HTTP cache (cache:"no-store").
// Without that, "network-first" isn't actually a hard guarantee — GitHub Pages serves these
// files with real Cache-Control lifetimes, so a plain fetch() can be silently satisfied by the
// browser's HTTP cache without a real round-trip, and a code update wouldn't show up even though
// this logic looks like it's always asking the network first.
const CACHE = "commonplace-shell-v3";
const SHELL = ["./", "./index.html", "./style.css", "./app.js", "./config.js", "./manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then((resp) => {
        if (resp.ok) caches.open(CACHE).then((cache) => cache.put(event.request, resp.clone()));
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
