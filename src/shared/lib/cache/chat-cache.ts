const DB_NAME = "bastyon-chat-cache";
const DB_VERSION = 2;
const ROOMS_STORE = "rooms";
const MESSAGES_STORE = "messages";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROOMS_STORE))
        db.createObjectStore(ROOMS_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        const store = db.createObjectStore(MESSAGES_STORE, { keyPath: "id" });
        store.createIndex("roomId", "roomId", { unique: false });
      }
    };
    req.onblocked = () => {
      console.warn("[chat-cache] DB upgrade blocked by another tab, proceeding without cache");
      dbPromise = null;
      reject(new Error("DB upgrade blocked"));
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

/** Strip Vue reactive proxies by deep-cloning to plain objects */
function toPlain<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export async function cacheRooms(rooms: unknown[]): Promise<void> {
  try {
    const plain = toPlain(rooms);
    const db = await openDB();
    const tx = db.transaction(ROOMS_STORE, "readwrite");
    const store = tx.objectStore(ROOMS_STORE);
    // Clear and re-populate
    store.clear();
    for (const room of plain) {
      store.put(room);
    }
  } catch (e) {
    console.warn("[chat-cache] cacheRooms failed:", e);
  }
}

export async function getCachedRooms(): Promise<unknown[]> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(ROOMS_STORE, "readonly");
      const req = tx.objectStore(ROOMS_STORE).getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

const CACHE_TS_PREFIX = "bastyon-cache-ts:";

export function getCacheTimestamp(roomId: string): number {
  const raw = localStorage.getItem(CACHE_TS_PREFIX + roomId);
  return raw ? parseInt(raw, 10) : 0;
}

export async function cacheMessages(roomId: string, messages: unknown[]): Promise<void> {
  localStorage.setItem(CACHE_TS_PREFIX + roomId, String(Date.now()));
  try {
    const db = await openDB();
    const tx = db.transaction(MESSAGES_STORE, "readwrite");
    const store = tx.objectStore(MESSAGES_STORE);
    // Delete existing messages for this room first
    const index = store.index("roomId");
    const range = IDBKeyRange.only(roomId);
    const cursorReq = index.openCursor(range);
    await new Promise<void>((resolve) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => resolve();
    });
    // Insert new messages (deep-clone to strip reactive proxies)
    const plain = toPlain(messages);
    for (const msg of plain) {
      store.put(msg);
    }
  } catch (e) {
    console.warn("[chat-cache] cacheMessages failed:", e);
  }
}

export async function getCachedMessages(roomId: string): Promise<unknown[]> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(MESSAGES_STORE, "readonly");
      const index = tx.objectStore(MESSAGES_STORE).index("roomId");
      const req = index.getAll(IDBKeyRange.only(roomId));
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

