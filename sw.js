/* ============================================================================
   DP·Trace BR — Service Worker
   Estratégia:
     - App shell (index.html, manifest): cache-first com atualização em background
     - CDNs (pdf.js, pdf-lib, fontkit, Google Fonts): stale-while-revalidate
     - Tudo mais: network-first com fallback de cache
   Versionar CACHE_NAME a cada release para invalidar o cache antigo.
   ============================================================================ */

const CACHE_VERSION = 'v0.6.3';
const CACHE_NAME    = `dptrace-br-${CACHE_VERSION}`;
const RUNTIME_CACHE = `dptrace-br-runtime-${CACHE_VERSION}`;

/* Recursos do próprio app — caminhos relativos para funcionar em
   https://<user>.github.io/<repo>/ sem precisar saber o nome do repo. */
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
];

/* CDNs que o app usa. Pre-cache no install garante 1ª execução offline. */
const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js',
  'https://unpkg.com/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js',
  'https://unpkg.com/docx@8.5.0/build/index.umd.js',
  'https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js',
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
];

/* ----------------------------------------------------------------------------
   INSTALL — pré-cacheia app shell e CDNs
   ---------------------------------------------------------------------------- */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // App shell — falhar aqui é problema (impede o install).
    await cache.addAll(APP_SHELL);
    // CDNs — falhar individualmente não impede o install
    // (rede pode estar ruim no momento da instalação).
    await Promise.allSettled(
      CDN_ASSETS.map(url =>
        cache.add(new Request(url, { mode: 'no-cors' })).catch(() => {})
      )
    );
    // Ativa imediatamente sem esperar o reload.
    await self.skipWaiting();
  })());
});

/* ----------------------------------------------------------------------------
   ACTIVATE — limpa caches antigos
   ---------------------------------------------------------------------------- */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => n !== CACHE_NAME && n !== RUNTIME_CACHE)
        .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/* ----------------------------------------------------------------------------
   FETCH — roteamento por tipo de recurso
   ---------------------------------------------------------------------------- */
self.addEventListener('fetch', event => {
  const req = event.request;

  // SW só lida com GET.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Ignora extensões do Chrome e devtools.
  if (url.protocol === 'chrome-extension:' || url.protocol === 'chrome:') return;

  // Navegação (HTML) — network-first, fallback offline para o index cacheado.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigate(req));
    return;
  }

  // CDNs conhecidos — stale-while-revalidate.
  if (isCDN(url)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Mesmo origem (assets do GitHub Pages) — cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Default — network com fallback de cache.
  event.respondWith(networkFirst(req));
});

/* ----------------------------------------------------------------------------
   ESTRATÉGIAS
   ---------------------------------------------------------------------------- */

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirstNavigate(req) {
  try {
    const res = await fetch(req);
    return res;
  } catch (e) {
    // Volta para o index cacheado quando offline.
    const cached = await caches.match('./index.html') || await caches.match('./');
    if (cached) return cached;
    return new Response('App indisponível offline', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone());
    }
    return res;
  }).catch(() => null);
  return cached || network || new Response('Offline', { status: 503 });
}

function isCDN(url) {
  return (
    url.hostname === 'cdnjs.cloudflare.com' ||
    url.hostname === 'unpkg.com' ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  );
}

/* ----------------------------------------------------------------------------
   MENSAGENS — permite forçar atualização a partir da página
   ---------------------------------------------------------------------------- */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
