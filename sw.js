// 画面の部品(プログラム)を端末に保存して、電波が悪くても開けるようにする。
// チャットのデータはここには保存しない(別の保存場所: IndexedDB)。
// 通信が使えるときは常に最新のプログラムを取りにいき、使えないときだけ保存分を使う。
const CACHE = 'teams-seiri-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // Microsoft への通信には触れない
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./')))
  );
});
