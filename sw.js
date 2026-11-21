// Enluminure — fonctionnement hors connexion.
// Réseau d'abord (les mises à jour arrivent tout de suite), copie locale si pas de connexion.
const CACHE = 'enluminure-v0.1.0';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/main.js', 'js/util.js', 'js/document.js', 'js/render.js', 'js/ops.js', 'js/io.js', 'js/view.js', 'js/ui.js', 'js/panels.js', 'js/icons.js',
  'vendor/ag-psd.min.js',
  'icons/sceau-enluminure.svg', 'icons/icone-appli.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('enluminure-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
