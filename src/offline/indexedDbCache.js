const DB_NAME = 'employee-tracker-cache';
const DB_VERSION = 1;
const STORE_NAME = 'kv';

/**
 * Minimal promise-based IndexedDB key-value wrapper — no library, just
 * the store this app actually needs. Backs the offline-first fallback:
 * each successful fetch snapshots its result here, so if a later fetch
 * fails (offline, backend down), the last-known-good data can still be
 * shown instead of an empty screen.
 */
function openDb() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB unavailable'));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                request.result.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function idbSet(key, value) {
    try {
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch {
        // IndexedDB unavailable (private browsing, unsupported) — skip caching silently
    }
}

export async function idbGet(key) {
    try {
        const db = await openDb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch {
        return undefined;
    }
}
