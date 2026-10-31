// Private on-device storage (IndexedDB). Nothing here ever leaves the phone unless exported.
const DB_NAME = "gymplan";
const DB_VERSION = 1;
export const STORES = ["kv", "sessions", "runs", "kicks", "checkins"];

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      for (const name of STORES.slice(1)) {
        if (!db.objectStoreNames.contains(name)) {
          const s = db.createObjectStore(name, { keyPath: "id" });
          s.createIndex("date", "date");
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && "result" in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const getSetting = (key, fallback = null) =>
  tx("kv", "readonly", (s) => s.get(key)).then((v) => (v === undefined ? fallback : v));
export const setSetting = (key, value) => tx("kv", "readwrite", (s) => s.put(value, key));

export const put = (store, record) => tx(store, "readwrite", (s) => s.put(record));
export const get = (store, id) => tx(store, "readonly", (s) => s.get(id));
export const remove = (store, id) => tx(store, "readwrite", (s) => s.delete(id));
export const all = (store) => tx(store, "readonly", (s) => s.getAll());

export async function exportAll() {
  const data = { app: "gym-plan", version: DB_VERSION, exported: new Date().toISOString(), kv: {} };
  const db = await open();
  await new Promise((resolve, reject) => {
    const t = db.transaction("kv");
    const req = t.objectStore("kv").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) { data.kv[c.key] = c.value; c.continue(); }
    };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  for (const name of STORES.slice(1)) data[name] = await all(name);
  return data;
}

// Replace everything on this phone with a backup (validated by the caller). One transaction: all or nothing.
export async function importAll(data) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const t = db.transaction(STORES, "readwrite");
    for (const name of STORES) t.objectStore(name).clear();
    for (const [k, v] of Object.entries(data.kv ?? {})) t.objectStore("kv").put(v, k);
    for (const name of STORES.slice(1)) for (const r of data[name] ?? []) t.objectStore(name).put(r);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function clearAll() {
  const db = await open();
  await new Promise((resolve, reject) => {
    const t = db.transaction(STORES, "readwrite");
    for (const name of STORES) t.objectStore(name).clear();
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
