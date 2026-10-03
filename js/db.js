// ブラウザ内の保存場所(IndexedDB)。データはこの端末のブラウザの中だけに残り、外部へは送らない。
const DB = 'teams-seiri';
const STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}

export const dbGet = (key, fallback = null) => tx('readonly', (s) => s.get(key)).then((v) => (v === undefined ? fallback : v));
export const dbSet = (key, value) => tx('readwrite', (s) => s.put(value, key));
export const dbDelete = (key) => tx('readwrite', (s) => s.delete(key));
