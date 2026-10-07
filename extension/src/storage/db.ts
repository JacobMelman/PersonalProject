// Structured metadata / index / journal store (IndexedDB). Large binary artifacts live in OPFS (see opfs.ts).
const DB_NAME = 'reprodesk';
const DB_VERSION = 1;

export type StoreName = 'segments' | 'events' | 'sessions' | 'shots' | 'reports' | 'journal';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const seg = db.createObjectStore('segments', { keyPath: 'id' });
      seg.createIndex('endWall', 'endWall');
      const ev = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
      ev.createIndex('sessionTs', ['sessionId', 'ts']);
      db.createObjectStore('sessions', { keyPath: 'id' });
      const shots = db.createObjectStore('shots', { keyPath: 'id' });
      shots.createIndex('sessionId', 'sessionId');
      const rep = db.createObjectStore('reports', { keyPath: 'id' });
      rep.createIndex('sessionId', 'sessionId');
      db.createObjectStore('journal', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function dbPut<T>(store: StoreName, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await done(tx);
}

export async function dbPutMany<T>(store: StoreName, values: T[]): Promise<void> {
  if (!values.length) return;
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  await done(tx);
}

export async function dbAdd<T>(store: StoreName, value: T): Promise<IDBValidKey> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const key = await wrap(tx.objectStore(store).add(value));
  await done(tx);
  return key;
}

export async function dbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function dbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).getAll()) as Promise<T[]>;
}

export async function dbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

export async function dbIndexAll<T>(store: StoreName, index: string, query: IDBValidKey | IDBKeyRange): Promise<T[]> {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).index(index).getAll(query)) as Promise<T[]>;
}

/** All events of one session ordered by timestamp. */
export async function eventsOfSession<T>(sessionId: string, from = 0, to = Number.MAX_SAFE_INTEGER): Promise<T[]> {
  return dbIndexAll<T>('events', 'sessionTs', IDBKeyRange.bound([sessionId, from], [sessionId, to]));
}

export async function deleteEventsRange(sessionId: string, from: number, to: number): Promise<number> {
  const db = await openDb();
  const tx = db.transaction('events', 'readwrite');
  const idx = tx.objectStore('events').index('sessionTs');
  let n = 0;
  await new Promise<void>((resolve, reject) => {
    const cur = idx.openCursor(IDBKeyRange.bound([sessionId, from], [sessionId, to]));
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      c.delete();
      n++;
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  await done(tx);
  return n;
}

export async function dbDeleteWhereSession(store: 'events' | 'shots' | 'reports', sessionId: string): Promise<void> {
  if (store === 'events') {
    await deleteEventsRange(sessionId, 0, Number.MAX_SAFE_INTEGER);
    return;
  }
  const rows = await dbIndexAll<{ id: string }>(store, 'sessionId', sessionId);
  for (const r of rows) await dbDelete(store, r.id);
}
