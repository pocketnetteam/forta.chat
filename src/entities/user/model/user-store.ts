import { defineStore } from "pinia";
import { shallowRef, triggerRef } from "vue";
import { createAppInitializer } from "@/app/providers/initializers/app-initializer";
import { ProfileLoader } from "@/shared/lib/profile-loader";
import { PromisePool } from "@/shared/lib/promise-pool";

import type { User } from "./types";

const NAMESPACE = "user";
const LS_KEY = "bastyon-chat-users";

/** How long a cached profile stays fresh (6 hours) */
const USER_TTL_MS = 6 * 60 * 60 * 1000;

/** Shared app initializer instance for loading user profiles on demand */
let _appInit: ReturnType<typeof createAppInitializer> | null = null;
function getAppInit() {
  if (!_appInit) _appInit = createAppInitializer();
  return _appInit;
}

/**
 * Unified in-flight request deduplication.
 * Replaces the old `pendingLoads` Map — all profile loading paths
 * (loadUserIfMissing, loadUsersBatch, enqueueProfiles) now share
 * a single pool, eliminating race conditions between them.
 */
const profilePool = new PromisePool<void>();

/** Debounced persistence to localStorage */
let _cacheTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedCacheUsers(usersRecord: Record<string, User>) {
  if (_cacheTimer) clearTimeout(_cacheTimer);
  _cacheTimer = setTimeout(() => {
    _cacheTimer = null;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(usersRecord));
    } catch { /* quota exceeded — ignore */ }
  }, 500);
}

/** Restore users from localStorage (synchronous) */
function readCachedUsers(): Record<string, User> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, User>;
  } catch {
    return {};
  }
}

export const useUserStore = defineStore(NAMESPACE, () => {
  // Restore from localStorage synchronously on store creation
  const cached = readCachedUsers();
  const users = shallowRef<Record<string, User>>(cached);

  const getUser = (address: string): User | undefined => {
    return users.value[address];
  };

  const setUser = (address: string, user: User) => {
    users.value[address] = user;
    triggerRef(users);
    debouncedCacheUsers(users.value);
  };

  const setUsers = (userList: User[]) => {
    for (const user of userList) {
      users.value[user.address] = user;
    }
    triggerRef(users);
    debouncedCacheUsers(users.value);
  };

  /** Load a single user profile. Deduplicated via PromisePool — 140 concurrent
   *  calls for the same address produce exactly 1 network request. */
  const loadUserIfMissing = (address: string): void => {
    if (!address || users.value[address]) return;
    if (profilePool.has(address)) return;

    profilePool.dedupe(address, async () => {
      try {
        const appInit = getAppInit();
        await appInit.initApi();
        const userData = await appInit.loadUserData([address]);
        if (userData) {
          users.value[address] = {
            address,
            name: userData.name ?? "",
            about: userData.about ?? "",
            image: userData.image ?? "",
            site: userData.site ?? "",
            language: userData.language ?? "",
            cachedAt: Date.now(),
          };
          triggerRef(users);
          debouncedCacheUsers(users.value);
        }
      } catch {
        // Silently fail — user will see address as fallback
      }
    }).catch(() => {});
  };

  /** Batch-load user profiles. Uses PromisePool.dedupeBatch to register
   *  all addresses SYNCHRONOUSLY before any await — closing the race window
   *  that existed between filter() and pendingLoads.set() in the old code. */
  const loadUsersBatch = async (addresses: string[]): Promise<void> => {
    const toLoad = addresses.filter(a => a && !users.value[a]);
    if (toLoad.length === 0) return;

    await profilePool.dedupeBatch(toLoad, async (uncached) => {
      try {
        const appInit = getAppInit();
        await appInit.initApi();
        await appInit.loadUsersBatch(uncached);
        let updated = false;
        for (const addr of uncached) {
          const userData = appInit.getUserData(addr);
          if (userData) {
            users.value[addr] = {
              address: addr,
              name: userData.name ?? "",
              about: userData.about ?? "",
              image: userData.image ?? "",
              site: userData.site ?? "",
              language: userData.language ?? "",
              cachedAt: Date.now(),
            };
            updated = true;
          }
        }
        if (updated) {
          triggerRef(users);
          debouncedCacheUsers(users.value);
        }
      } catch {
        // Silently fail
      }
    });
  };

  /** DataLoader-style profile loading: collects all requests within a microtick
   *  into batches of 30, with yielding between batches for UI responsiveness.
   *  Use this instead of calling loadUsersBatch directly from hot paths. */
  const profileLoader = new ProfileLoader((addrs) => loadUsersBatch(addrs));
  const enqueueProfiles = (addresses: string[]) => profileLoader.load(addresses);

  /** Background-refresh stale profiles without blocking UI.
   *  Processes in small batches with delays so the user never notices. */
  const refreshStaleUsers = async () => {
    const now = Date.now();
    const stale = Object.keys(users.value).filter(addr => {
      const u = users.value[addr];
      return !u.cachedAt || now - u.cachedAt > USER_TTL_MS;
    });
    if (stale.length === 0) return;

    const BATCH = 10;
    for (let i = 0; i < stale.length; i += BATCH) {
      const batch = stale.slice(i, i + BATCH);
      try {
        const appInit = getAppInit();
        await appInit.initApi();
        await appInit.loadUsersBatch(batch);
        let updated = false;
        for (const addr of batch) {
          const userData = appInit.getUserData(addr);
          if (userData) {
            users.value[addr] = {
              address: addr,
              name: userData.name ?? "",
              about: userData.about ?? "",
              image: userData.image ?? "",
              site: userData.site ?? "",
              language: userData.language ?? "",
              cachedAt: now,
            };
            updated = true;
          }
        }
        if (updated) {
          triggerRef(users);
          debouncedCacheUsers(users.value);
        }
      } catch {
        // Network issue — skip, will retry next cycle
      }
      // Yield between batches so we don't block anything
      if (i + BATCH < stale.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  };

  // Schedule background refresh shortly after startup, then periodically
  let _refreshTimer: ReturnType<typeof setInterval> | null = null;
  const startBackgroundRefresh = () => {
    // Initial refresh after 30s to let the app settle
    setTimeout(() => {
      refreshStaleUsers();
      // Then repeat every 6 hours
      _refreshTimer = setInterval(refreshStaleUsers, USER_TTL_MS);
    }, 30_000);
  };

  startBackgroundRefresh();

  return {
    enqueueProfiles,
    getUser,
    loadUserIfMissing,
    loadUsersBatch,
    setUser,
    setUsers,
    users
  };
});
