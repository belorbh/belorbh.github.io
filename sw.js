/* Belor — service worker: app offline + notificações (Web Push) */
const VERSAO = 'belor-1.4.1';
const BASE = new URL('./', self.location).pathname;
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
  'fonts/montserrat-latin-400-normal.woff2', 'fonts/montserrat-latin-500-normal.woff2',
  'fonts/montserrat-latin-600-normal.woff2', 'fonts/montserrat-latin-700-normal.woff2',
  'fonts/montserrat-latin-800-normal.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter(k => k.startsWith('belor-') && k !== VERSAO).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Só arquivos do próprio app passam por aqui; os dados (Google) vão direto pra rede.
// Página, JS e CSS: rede primeiro (atualização aparece na hora), cache se estiver sem internet.
// Ícones e fontes: cache primeiro.
function comPrazo(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('prazo')), ms))]); }
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const estatico = /\.(png|woff2|ico)$/.test(url.pathname);
  e.respondWith((async () => {
    const c = await caches.open(VERSAO);
    const chave = req.mode === 'navigate' ? 'index.html' : req;
    if (estatico) {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const r = await fetch(req); if (r && r.ok) c.put(req, r.clone()); return r;
    }
    try {
      // navegação não aceita opções no fetch(req): busca pela URL
      const r = await comPrazo(fetch(req.mode === 'navigate' ? url.href : req, { cache: 'no-store' }), 6000);
      if (r && r.ok) c.put(chave, r.clone());
      return r;
    } catch (err) {
      return (await c.match(chave, { ignoreSearch: true })) || (await c.match('./')) || Response.error();
    }
  })());
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Belor', body: e.data ? e.data.text() : '' }; }
  const titulo = d.title || 'Belor';
  const op = {
    body: d.body || 'Novidade na loja',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { tab: d.tab || 'hoje', url: d.url || '' },
    timestamp: Date.now()
  };
  e.waitUntil((async () => {
    try {
      if (typeof d.badge === 'number' && self.navigator.setAppBadge) {
        if (d.badge > 0) await self.navigator.setAppBadge(d.badge); else await self.navigator.clearAppBadge();
      }
    } catch (err) {}
    await self.registration.showNotification(titulo, op);
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    cs.forEach(c => c.postMessage({ tipo: 'push', tab: op.data.tab }));
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const tab = (e.notification.data && e.notification.data.tab) || 'hoje';
  const alvo = BASE + '?tab=' + encodeURIComponent(tab);
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) {
      if (new URL(c.url).pathname.startsWith(BASE)) {
        c.postMessage({ tipo: 'abrir', tab });
        return c.focus();
      }
    }
    return self.clients.openWindow(alvo);
  })());
});
