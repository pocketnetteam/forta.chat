import { defineStore } from "pinia";
import { shallowRef, triggerRef } from "vue";
import { createAppInitializer } from "@/app/providers/initializers/app-initializer";
import { ProfileLoader, PROFILE_LOADER_BATCH_ACTIVE } from "@/shared/lib/profile-loader";
import { PromisePool } from "@/shared/lib/promise-pool";

import { mergeUserUpdate } from "./merge-user-update";
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

  // Coalesce rapid triggerRef calls into a single reactive notification.
  // During first load, loadUsersBatch fires 10-13 times in quick succession —
  // each triggerRef causes a full Vue re-render cascade (~370ms long task).
  // This debounce collapses them into 1 trigger, eliminating the 2-minute freeze.
  // When ProfileLoader batch is active, skip entirely — the onFlushComplete
  // callback fires a single triggerRef after ALL batches complete.
  let _triggerTimer: ReturnType<typeof setTimeout> | null = null;
  function debouncedTrigger(): void {
    if (PROFILE_LOADER_BATCH_ACTIVE.active) return; // suppress during batch
    if (_triggerTimer) return; // already scheduled
    _triggerTimer = setTimeout(() => {
      _triggerTimer = null;
      triggerRef(users);
    }, 100);
  }

  const getUser = (address: string): User | undefined => {
    return users.value[address];
  };

  const setUser = (address: string, user: User) => {
    users.value[address] = user;
    triggerRef(users); // immediate — single user updates are rare and should be instant
    debouncedCacheUsers(users.value);
  };

  const setUsers = (userList: User[]) => {
    for (const user of userList) {
      users.value[user.address] = user;
    }
    debouncedTrigger();
    debouncedCacheUsers(users.value);
  };

  /** How long an empty-name profile stays before we retry (30 seconds) */
  const EMPTY_NAME_RETRY_MS = 30_000;

  /** Load a single user profile. Deduplicated via PromisePool — 140 concurrent
   *  calls for the same address produce exactly 1 network request.
   *  Re-fetches if cached profile has an empty name (e.g. fetched before
   *  blockchain confirmation during registration).
   *  STALE-WHILE-REVALIDATE: stale profiles with a name trigger background
   *  revalidation without blocking — the UI always has data to show. */
  const loadUserIfMissing = (address: string): void => {
    if (!address) return;
    const cached = users.value[address];
    if (cached && cached.name) {
      // Has real name — check if stale and schedule background revalidation
      if (cached.cachedAt && Date.now() - cached.cachedAt > USER_TTL_MS) {
        _scheduleBackgroundRevalidation([address]);
      }
      return;
    }
    if (cached && cached.cachedAt && Date.now() - cached.cachedAt < EMPTY_NAME_RETRY_MS) return; // empty but recently tried
    if (profilePool.has(address)) return;

    profilePool.dedupe(address, async () => {
      try {
        const appInit = getAppInit();
        await appInit.initApi();
        const userData = await appInit.loadUserData([address]);
        if (userData) {
          users.value[address] = mergeUserUpdate(users.value[address], {
            address,
            name: userData.name ?? "",
            about: userData.about ?? "",
            image: userData.image ?? "",
            site: userData.site ?? "",
            language: userData.language ?? "",
          });
          debouncedTrigger();
          debouncedCacheUsers(users.value);
        }
      } catch {
        // Silently fail — user will see address as fallback
      }
    }).catch(() => {});
  };

  /** Batch-load user profiles. Uses PromisePool.dedupeBatch to register
   *  all addresses SYNCHRONOUSLY before any await — closing the race window
   *  that existed between filter() and pendingLoads.set() in the old code.
   *
   *  STALE-WHILE-REVALIDATE: profiles with a name are returned from cache
   *  immediately (no blocking). If they're older than USER_TTL_MS, a background
   *  revalidation is queued — but the UI never sees a blank/loading state. */
  const loadUsersBatch = async (addresses: string[]): Promise<void> => {
    const now = Date.now();
    const toLoad: string[] = [];
    const toRevalidate: string[] = [];

    for (const a of addresses) {
      if (!a) continue;
      const cached = users.value[a];
      if (!cached) {
        toLoad.push(a); // not cached at all — must fetch
      } else if (!cached.name && (!cached.cachedAt || now - cached.cachedAt >= EMPTY_NAME_RETRY_MS)) {
        toLoad.push(a); // empty name, stale — must fetch
      } else if (cached.name && cached.cachedAt && now - cached.cachedAt > USER_TTL_MS) {
        toRevalidate.push(a); // has data but stale — revalidate in background
      }
    }

    // Background revalidation: fire-and-forget, never blocks UI.
    // _scheduleBackgroundRevalidation applies its own REVALIDATE_CAP internally.
    if (toRevalidate.length > 0) {
      _scheduleBackgroundRevalidation(toRevalidate);
    }

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
            users.value[addr] = mergeUserUpdate(users.value[addr], {
              address: addr,
              name: userData.name ?? "",
              about: userData.about ?? "",
              image: userData.image ?? "",
              site: userData.site ?? "",
              language: userData.language ?? "",
            });
            updated = true;
          }
        }
        if (updated) {
          debouncedTrigger();
          debouncedCacheUsers(users.value);
        }
      } catch {
        // Silently fail
      }
    });
  };

  /** Max stale addresses to revalidate in one cycle.
   *  Stale profiles already have names visible in UI — revalidation is cosmetic.
   *  Cap prevents network saturation when 500+ profiles expire simultaneously
   *  (e.g. app reopened after 6+ hours). Excess addresses are silently dropped
   *  and will be picked up by the periodic refreshStaleUsers cycle. */
  const REVALIDATE_CAP = 50;

  /** Debounced background revalidation — collects stale addresses and
   *  processes them in a single batch after a short delay. This prevents
   *  100+ individual network requests when opening the room list. */
  let _revalidateTimer: ReturnType<typeof setTimeout> | null = null;
  let _revalidateQueue = new Set<string>();

  function _scheduleBackgroundRevalidation(addresses: string[]) {
    for (const a of addresses) {
      // Hard cap: drop excess stale addresses (UI already shows cached name).
      // refreshStaleUsers will catch them in the next 6h cycle.
      if (_revalidateQueue.size >= REVALIDATE_CAP) break;
      _revalidateQueue.add(a);
    }
    if (_revalidateTimer) return; // already scheduled

    _revalidateTimer = setTimeout(async () => {
      _revalidateTimer = null;
      const batch = [..._revalidateQueue];
      _revalidateQueue = new Set();
      if (batch.length === 0) return;

      // Process in chunks of 10 with yielding — same as refreshStaleUsers
      const BATCH = 10;
      for (let i = 0; i < batch.length; i += BATCH) {
        const chunk = batch.slice(i, i + BATCH);
        try {
          const appInit = getAppInit();
          await appInit.initApi();
          await appInit.loadUsersBatch(chunk);
          let updated = false;
          for (const addr of chunk) {
            const userData = appInit.getUserData(addr);
            if (userData) {
              users.value[addr] = mergeUserUpdate(users.value[addr], {
                address: addr,
                name: userData.name ?? "",
                about: userData.about ?? "",
                image: userData.image ?? "",
                site: userData.site ?? "",
                language: userData.language ?? "",
              });
              updated = true;
            }
          }
          if (updated) {
            debouncedTrigger();
            debouncedCacheUsers(users.value);
          }
        } catch {
          // Network issue — stale profiles remain visible, retry on next cycle
        }
        if (i + BATCH < batch.length) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }, 200); // 200ms debounce — coalesce concurrent loadUsersBatch calls
  }

  /** DataLoader-style profile loading: collects all requests within a microtick
   *  into batches of 30, with yielding between batches for UI responsiveness.
   *  Use this instead of calling loadUsersBatch directly from hot paths.
   *  onFlushComplete triggers a single reactive update after ALL batches complete. */
  const profileLoader = new ProfileLoader(
    (addrs) => loadUsersBatch(addrs),
    () => {
      // Single triggerRef after all batches instead of N intermediate ones
      if (_triggerTimer) { clearTimeout(_triggerTimer); _triggerTimer = null; }
      triggerRef(users);
      debouncedCacheUsers(users.value);
    },
  );
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
            users.value[addr] = mergeUserUpdate(users.value[addr], {
              address: addr,
              name: userData.name ?? "",
              about: userData.about ?? "",
              image: userData.image ?? "",
              site: userData.site ?? "",
              language: userData.language ?? "",
            }, now);
            updated = true;
          }
        }
        if (updated) {
          debouncedTrigger();
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

  const cleanup = () => {
    users.value = {};
    triggerRef(users);
    if (_triggerTimer) { clearTimeout(_triggerTimer); _triggerTimer = null; }
    if (_cacheTimer) { clearTimeout(_cacheTimer); _cacheTimer = null; }
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
    if (_revalidateTimer) { clearTimeout(_revalidateTimer); _revalidateTimer = null; }
    _revalidateQueue = new Set();
    localStorage.removeItem(LS_KEY);
  };

  return {
    cleanup,
    enqueueProfiles,
    getUser,
    loadUserIfMissing,
    loadUsersBatch,
    setUser,
    setUsers,
    users
  };
});
