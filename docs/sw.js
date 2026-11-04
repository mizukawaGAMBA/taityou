/* Service Worker — 画面のファイルをキャッシュして、通信が不安定でも開けるようにする。
 * API(別オリジンの Apps Script)はキャッシュしない。更新は「ネットワーク優先、失敗したらキャッシュ」。 */
const CACHE = 'kuma-v2';
const SHELL = [
  './', './index.html', './app.js', './config.js', './style.css', './manifest.webmanifest',
  './report.html', './report.js',
  './icons/bear.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  './images/images.js', './images/kuma-normal.svg', './images/kuma-happy.svg', './images/kuma-sleepy.svg',
  './images/kuma-love.svg', './images/kuma-cheer.svg', './images/kuma-crown.svg'
];
// images.js に登録したそれ以外の画像は、一度表示されたときにキャッシュされる(ネットワーク優先)

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(u)))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API などは触らない
  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
