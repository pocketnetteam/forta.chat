/**
 * IndexedDB-based storage for encrypted messages cache.
 * Ported from bastyon-chat/src/application/chatstorage.js
 */

export interface ChatStorageInstance {
  get(itemId: string): Promise<unknown>;
  set(itemId: string, message: unknown): Promise<boolean>;
  clear(itemId: string): Promise<boolean>;
}

const SECONDS_IN_HOUR = 3600;
const SECONDS_IN_MONTH = SECONDS_IN_HOUR * 24 * 30;

function getHourUnixtime(): number {
  const dateNow = Math.floor(Date.now() / 1000);
  return dateNow - (dateNow % SECONDS_IN_HOUR);
}

export function createChatStorage(
  storageName: string,
  version = 1,
  cacheTime = SECONDS_IN_MONTH
): Promise<ChatStorageInstance> {
  const memoryStorage: Record<string, unknown> = {};

  if (!window.indexedDB) {
    return Promise.resolve(createLocalStorageFallback(storageName));
  }

  return new Promise((resolve, reject) => {
    const openRequest = indexedDB.open(storageName, version);

    openRequest.onupgradeneeded = (e: IDBVersionChangeEvent) => {
      const db = openRequest.result;
      const isVersionChanged = e.oldVersion !== e.newVersion;
      const didExistBefore = e.oldVersion !== 0;

      if (isVersionChanged && didExistBefore && !db.objectStoreNames.contains("items")) {
        try { db.deleteObjectStore("items"); } catch { /* ignore */ }
      }
      if (!db.objectStoreNames.contains("items")) {
        db.createObjectStore("items", { keyPath: "id" });
      }
    };

    openRequest.onerror = () => reject("ChatStorage: error initiating IndexedDB");

    openRequest.onsuccess = () => {
      const db = openRequest.result;

      const openTransaction = () => db.transaction("items", "readwrite");

      const clearOldItems = (): Promise<void> => {
        const threshold = getHourUnixtime() - cacheTime;
        const tx = openTransaction();
        const store = tx.objectStore("items");
        const req = store.openCursor();
        return new Promise((res) => {
          req.onsuccess = (ev) => {
            const cursor = (ev.target as IDBRequest<IDBCursorWithValue>).result;
            if (cursor) {
              if (threshold >= cursor.value.cachedAt) cursor.delete();
              cursor.continue();
            }
            res();
          };
          req.onerror = () => res();
        });
      };

      clearOldItems()
        .then(() => {
          resolve({
            get(itemId: string): Promise<unknown> {
              if (memoryStorage[itemId] !== undefined) {
                return Promise.resolve(memoryStorage[itemId]);
              }
              return new Promise((res, rej) => {
                const tx = openTransaction();
                const store = tx.objectStore("items");
                const req = store.get(itemId);
                req.onsuccess = () => {
                  if (!req.result || !("message" in req.result)) {
                    return rej("Data does not exist");
                  }
                  memoryStorage[itemId] = req.result.message;
                  res(req.result.message);
                };
                req.onerror = () => rej("Read error");
              });
            },

            set(itemId: string, message: unknown): Promise<boolean> {
              memoryStorage[itemId] = message;
              return new Promise((res, rej) => {
                const tx = openTransaction();
                const store = tx.objectStore("items");
                const req = store.put({
                  id: itemId,
                  message,
                  cachedAt: getHourUnixtime()
                });
                req.onsuccess = () => res(true);
                req.onerror = () => rej("Write error");
              });
            },

            clear(itemId: string): Promise<boolean> {
              delete memoryStorage[itemId];
              return new Promise((res, rej) => {
                const tx = openTransaction();
                const store = tx.objectStore("items");
                const req = store.delete(itemId);
                req.onsuccess = () => res(true);
                req.onerror = () => rej("Delete error");
              });
            }
          });
        });
    };
  });
}

function createLocalStorageFallback(storageName: string): ChatStorageInstance {
  return {
    get(itemId: string): Promise<unknown> {
      const key = `${storageName}_${itemId}`;
      if (!(key in localStorage)) return Promise.reject("Data does not exist");
      try {
        const parsed = JSON.parse(localStorage[key]);
        return Promise.resolve(parsed.message);
      } catch {
        return Promise.reject("Parse error");
      }
    },
    set(itemId: string, message: unknown): Promise<boolean> {
      const key = `${storageName}_${itemId}`;
      localStorage[key] = JSON.stringify({ message, cachedAt: getHourUnixtime() });
      return Promise.resolve(true);
    },
    clear(itemId: string): Promise<boolean> {
      delete localStorage[`${storageName}_${itemId}`];
      return Promise.resolve(true);
    }
  };
}
