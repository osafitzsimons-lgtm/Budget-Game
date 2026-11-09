/// <reference lib="webworker" />
// Caches static files only. API responses (/api/*) are never cached.
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = 'budget-guy-static-v1';

sw.addEventListener('install', () => {
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await sw.clients.claim();
    })(),
  );
});

function isStatic(url: URL): boolean {
  return url.origin === sw.location.origin && !url.pathname.startsWith('/api/') && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/pdfjs/') || url.pathname === '/manifest.webmanifest');
}

sw.addEventListener('fetch', (event: FetchEvent) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin || url.pathname.startsWith('/api/')) return; // never touch API calls

  if (req.mode === 'navigate') {
    // Network first so Cloudflare Access can redirect to sign-in; cached shell only when offline.
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok && res.type === 'basic' && !res.redirected) {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        } catch {
          return (await caches.match('/')) ?? new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
        }
      })(),
    );
    return;
  }

  if (isStatic(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok && res.type === 'basic' && !res.redirected) {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })(),
    );
  }
});
