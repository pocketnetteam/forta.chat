import { SessionManager } from "./session-manager";
import { purgeEmptySelfProfiles } from "../lib/self-profile-cache";

/** Forta user-store localStorage key (see entities/user/model/user-store.ts). */
const USER_STORE_LS_KEY = "bastyon-chat-users";

/** One-shot flag: empty profile purge already ran on this device. */
const EMPTY_PROFILE_PURGE_FLAG = "forta-chat:empty-profile-purge-v1";

/**
 * Migrate global pinned/muted room keys to per-account format.
 * Idempotent: skips if per-account key already exists.
 */
export function migratePerAccountKeys(address: string): void {
  const keys = ["chat_pinned_rooms", "chat_muted_rooms"] as const;

  for (const key of keys) {
    const perAccountKey = `${key}:${address}`;

    // Skip if per-account key already exists
    if (localStorage.getItem(perAccountKey) !== null) continue;

    const oldValue = localStorage.getItem(key);
    if (oldValue === null) continue;

    localStorage.setItem(perAccountKey, oldValue);
    localStorage.removeItem(key);
  }
}

/**
 * Migrate global Pcrypto caches ("messages", "events") to per-account format.
 * Non-blocking, fire-and-forget. These are just TTL'd caches — safe to lose.
 */
export async function migrateCryptoStorage(address: string): Promise<void> {
  if (!window.indexedDB?.databases) return;

  try {
    const dbs = await window.indexedDB.databases();
    for (const name of ["messages", "events"]) {
      const perAccountName = `${name}:${address}`;
      const globalExists = dbs.some(db => db.name === name);
      const perAccountExists = dbs.some(db => db.name === perAccountName);

      if (globalExists && !perAccountExists) {
        // Cache is TTL'd (30 days) — just delete global, it regenerates
        indexedDB.deleteDatabase(name);
      }
    }
  } catch (e) {
    console.warn("[migration] Pcrypto cache migration failed:", e);
  }
}

/** Drop empty-name entries from the Forta user-store localStorage cache. */
export function purgeEmptyUserStoreProfiles(): number {
  try {
    const raw = localStorage.getItem(USER_STORE_LS_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as Record<string, { name?: string }>;
    if (!parsed || typeof parsed !== "object") return 0;

    let removed = 0;
    const kept: Record<string, { name?: string }> = {};
    for (const [address, user] of Object.entries(parsed)) {
      if (!String(user?.name ?? "").trim()) {
        removed++;
        continue;
      }
      kept[address] = user;
    }
    if (removed > 0) {
      localStorage.setItem(USER_STORE_LS_KEY, JSON.stringify(kept));
    }
    return removed;
  } catch (e) {
    console.warn("[migration] empty user-store purge failed:", e);
    return 0;
  }
}

/**
 * Drop empty-name rows from the Pocketnet SDK profile IndexedDB
 * (`psdk_production` / `psdk_test` → userInfoFull / userInfoLight / userInfoFullFB).
 */
export async function purgeEmptyPsdkUserInfo(): Promise<number> {
  if (typeof indexedDB === "undefined") return 0;

  const dbName =
    typeof window !== "undefined" && (window as { testpocketnet?: boolean }).testpocketnet
      ? "psdk_test"
      : "psdk_production";
  const stores = ["userInfoFull", "userInfoLight", "userInfoFullFB"] as const;

  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(dbName);
    } catch {
      resolve(0);
      return;
    }

    req.onerror = () => resolve(0);
    req.onsuccess = () => {
      const db = req.result;
      const existing = stores.filter((name) => db.objectStoreNames.contains(name));
      if (existing.length === 0) {
        db.close();
        resolve(0);
        return;
      }

      let removed = 0;
      const tx = db.transaction(existing, "readwrite");
      tx.oncomplete = () => {
        db.close();
        resolve(removed);
      };
      tx.onerror = () => {
        db.close();
        resolve(removed);
      };

      for (const storeName of existing) {
        const store = tx.objectStore(storeName);
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const value = cursor.value as { message?: { name?: string; n?: string } };
          const name = value?.message?.name ?? value?.message?.n ?? "";
          if (!String(name).trim()) {
            cursor.delete();
            removed++;
          }
          cursor.continue();
        };
      }
    };
  });
}

/**
 * One-shot purge of empty profiles left by older builds that cached
 * pre-registration getuserprofile misses. Safe to call on every boot —
 * subsequent runs are no-ops via the flag.
 */
export function purgeEmptyProfilesOnce(): void {
  try {
    if (localStorage.getItem(EMPTY_PROFILE_PURGE_FLAG) === "1") return;
  } catch {
    return;
  }

  const fromStore = purgeEmptyUserStoreProfiles();
  const fromSelf = purgeEmptySelfProfiles();
  purgeEmptyPsdkUserInfo()
    .then((fromPsdk) => {
      if (fromStore + fromSelf + fromPsdk > 0) {
        console.info(
          "[migration] purged empty profiles — user-store:",
          fromStore,
          "self:",
          fromSelf,
          "psdk:",
          fromPsdk,
        );
      }
    })
    .catch(() => { /* non-fatal */ });

  try {
    localStorage.setItem(EMPTY_PROFILE_PURGE_FLAG, "1");
  } catch {
    /* ignore */
  }
}

/**
 * Run all storage migrations in order.
 * Called at app startup before auth store init.
 */
export function migrateAll(): void {
  const sm = new SessionManager();

  // Migrate singleton auth → multi-account sessions
  sm.migrate();

  // Migrate global pinned/muted keys to per-account format
  const active = sm.getActiveAddress();
  if (active) {
    migratePerAccountKeys(active);
    // Fire-and-forget: migrate Pcrypto caches (async, non-blocking)
    migrateCryptoStorage(active).catch(() => {});
  }

  // Drop empty getuserprofile rows that older builds cached locally.
  purgeEmptyProfilesOnce();
}
