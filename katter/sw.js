// Offline support for the Batman & Harvey calendar.
// - The page itself: network first, so updates arrive straight away; cached copy when offline.
// - Versioned files, fonts, the confetti library and photos: cache first (they never change).
// - Progress from the GitHub API: network first, cached copy when offline.
const CACHE = 'katter-v1';
const SHELL = ['./', 'cats.svg?v=2', 'icon.png', 'batman.png', 'harvey.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// `key` lets requests that differ only by a cache-busting query share one cache entry.
async function networkFirst(request, key = request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(key, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(key, { ignoreVary: true });
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // saves always go straight to GitHub
  const url = new URL(request.url);

  if (url.hostname === 'api.github.com') {
    if (url.pathname.endsWith('/contents/katter/data.json')) event.respondWith(networkFirst(request));
    return;
  }
  if (url.hostname === 'api.open-meteo.com') return; // weather is live-only

  const sameOrigin = url.origin === self.location.origin;
  const immutable =
    url.search.includes('v=') ||
    url.pathname.includes('/photos/') ||
    ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'raw.githubusercontent.com'].includes(url.hostname);

  if (sameOrigin && url.pathname.endsWith('/data.json')) event.respondWith(networkFirst(request, url.origin + url.pathname));
  else if (immutable) event.respondWith(cacheFirst(request));
  else if (sameOrigin) event.respondWith(networkFirst(request));
});
