// Кэширует приложение, чтобы оно открывалось без интернета.
// Отдаём из кэша сразу, а свежую версию тихо подтягиваем на следующий запуск.
const CACHE = 'split-v1';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'imaging.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const fresh = fetch(req).then(async (res) => {
    if (res.ok) await (await caches.open(CACHE)).put(req, res.clone());
    return res;
  });
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fresh));
  e.waitUntil(fresh.catch(() => {}));
});
