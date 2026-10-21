import { SESSION_DB_NAME } from '../constants.js';
import { parseSessionPayload } from './sessionPayload.js';

const STORE = 'kv';
const KEY = 'session';

/** @type {IDBDatabase | null} */
let openConn = null;

function openDb() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available.'));
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SESSION_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      openConn = req.result;
      openConn.onclose = () => {
        if (openConn === req.result) openConn = null;
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error || new Error('Could not open session storage.'));
  });
}

function closeDb() {
  if (!openConn) return;
  try {
    openConn.close();
  } catch {
    /* ignore */
  }
  openConn = null;
}

/**
 * @template T
 * @param {IDBDatabase} db
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest<T>} fn
 */
function withStore(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error || req.error);
    tx.onabort = () => reject(tx.error || req.error);
  });
}

/** @param {object} payload */
export async function saveSession(payload) {
  const db = await openDb();
  await withStore(db, 'readwrite', (store) => store.put(payload, KEY));
}

export async function loadSession() {
  try {
    const db = await openDb();
    const raw = await withStore(db, 'readonly', (store) => store.get(KEY));
    if (!raw) return null;
    return parseSessionPayload(raw);
  } catch {
    return null;
  }
}

export async function clearSession() {
  closeDb();
  if (typeof indexedDB === 'undefined') return;
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(SESSION_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('Could not clear session storage.'));
    req.onblocked = () => resolve();
  });
}
