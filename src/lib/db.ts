// IndexedDB: una canción por deck (ids 'a' y 'b')
import type { Song } from './types';

const STORE = 'session';
let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = () => (dbPromise ??= new Promise<IDBDatabase>((res, rej) => {
  const r = indexedDB.open('bpm-player', 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
  r.onsuccess = () => { r.result.onclose = () => (dbPromise = null); res(r.result); };
  r.onerror = () => { dbPromise = null; rej(r.error); };
}));

const tx = async <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
  const db = await openDb();
  return new Promise<T>((res, rej) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
};

export const dbAll = () => tx<any[]>('readonly', (s) => s.getAll());
export const dbPut = (song: Song) => tx('readwrite', (s) => s.put(song));
export const dbDel = (id: string) => tx('readwrite', (s) => s.delete(id));
export const dbClear = () => tx('readwrite', (s) => s.clear());
