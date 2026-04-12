import { defineStore } from "pinia";
import { shallowRef, triggerRef } from "vue";
import { createAppInitializer } from "@/app/providers/initializers/app-initializer";
import { useAuthStore } from "@/entities/auth/model/stores";
import { ProfileLoader, PROFILE_LOADER_BATCH_ACTIVE } from "@/shared/lib/profile-loader";
import { PromisePool } from "@/shared/lib/promise-pool";

import type { User } from "./types";

const NAMESPACE = "user";
const LS_KEY = "bastyon-chat-users";

/** How long a cached profile stays fresh (7 days).
 *  Stale-while-revalidate ensures the UI never blocks — revalidation is background-only. */
const USER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

  /** Load a single user profile via batched ProfileLoader.
   *  All calls within a microtick are collected into one batch (up to 30 addresses),
   *  producing a single getuserprofile RPC instead of N individual calls.
   *  STALE-WHILE-REVALIDATE: stale profiles with a name trigger background
   *  revalidation without blocking — the UI always has data to show. */
  const loadUserIfMissing = (address: string): void => {
    if (!address) return;
    const cached = users.value[address];
    if (cached?.deleted) return;
    if (cached && cached.name) {
      if (cached.cachedAt && Date.now() - cached.cachedAt > USER_TTL_MS) {
        _scheduleBackgroundRevalidation([address]);
      }
      return;
    }
    if (cached && cached.cachedAt && Date.now() - cached.cachedAt < EMPTY_NAME_RETRY_MS) return;
    if (profilePool.has(address)) return;
    enqueueProfiles([address]);
  };

  /** Helper: fetch addresses via pSDK and write results to users.value.
   *  @param setCachedAt  When false the profile is stored without cachedAt,
   *                      forcing a re-fetch on next load (used during registration). */
  const _fetchAndStore = async (addrs: string[], setCachedAt = true): Promise<void> => {
    const appInit = getAppInit();
    await appInit.initApi();
    await appInit.loadUsersBatch(addrs);
    let updated = false;
    for (const addr of addrs) {
      const userData = appInit.getUserData(addr);
      if (userData) {
        const isDeleted = (userData as any).deleted === true;
        users.value[addr] = {
          address: addr,
          name: userData.name ?? "",
          about: userData.about ?? "",
          image: userData.image ?? "",
          site: userData.site ?? "",
          language: userData.language ?? "",
          cachedAt: setCachedAt ? Date.now() : undefined,
          ...(isDeleted && { deleted: true }),
        };
        updated = true;
      }
    }
    if (updated) {
      debouncedTrigger();
      debouncedCacheUsers(users.value);
    }
  };

  /** Batch-load user profiles. Uses PromisePool.dedupeBatch to register
   *  all addresses SYNCHRONOUSLY before any await — closing the race window
   *  that existed between filter() and pendingLoads.set() in the old code.
   *
   *  Own address is always batched separately so it never inflates other batches.
   *  During registration, own address bypasses the cache entirely.
   *
   *  STALE-WHILE-REVALIDATE: profiles with a name are returned from cache
   *  immediately (no blocking). If they're older than USER_TTL_MS, a background
   *  revalidation is queued — but the UI never sees a blank/loading state. */
  const loadUsersBatch = async (addresses: string[]): Promise<void> => {
    const now = Date.now();

    // Separate own address — always batched independently
    let myAddr: string | undefined;
    let isRegistering = false;
    try {
      const authStore = useAuthStore();
      myAddr = authStore.address || undefined;
      isRegistering = !!authStore.registrationPending;
    } catch { /* auth store not ready yet — treat all as "other" */ }

    const toLoad: string[] = [];
    const toRevalidate: string[] = [];
    let loadSelf = false;

    for (const a of addresses) {
      if (!a) continue;
      if (a === myAddr) {
        // Own address: always separate; during registration always force-fetch
        if (isRegistering) {
          loadSelf = true;
        } else {
          const cached = users.value[a];
          if (!cached || (!cached.name && (!cached.cachedAt || now - cached.cachedAt >= EMPTY_NAME_RETRY_MS))) {
            loadSelf = true;
          } else if (cached.name && cached.cachedAt && now - cached.cachedAt > USER_TTL_MS) {
            toRevalidate.push(a);
          }
        }
        continue;
      }
      const cached = users.value[a];
      if (cached?.deleted) continue;
      if (!cached) {
        toLoad.push(a);
      } else if (!cached.name && (!cached.cachedAt || now - cached.cachedAt >= EMPTY_NAME_RETRY_MS)) {
        toLoad.push(a);
      } else if (cached.name && cached.cachedAt && now - cached.cachedAt > USER_TTL_MS) {
        toRevalidate.push(a);
      }
    }

    // Background revalidation: fire-and-forget, never blocks UI.
    if (toRevalidate.length > 0) {
      _scheduleBackgroundRevalidation(toRevalidate);
    }

    // Load own address in a separate batch (never mixed with others)
    const selfPromise = loadSelf && myAddr
      ? profilePool.dedupeBatch([myAddr], async (addrs) => {
          try {
            await _fetchAndStore(addrs, !isRegistering);
          } catch { /* silently fail */ }
        })
      : undefined;

    // Load other addresses
    const othersPromise = toLoad.length > 0
      ? profilePool.dedupeBatch(toLoad, async (uncached) => {
          try {
            await _fetchAndStore(uncached);
          } catch { /* silently fail */ }
        })
      : undefined;

    await Promise.all([selfPromise, othersPromise].filter(Boolean));
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

      const BATCH = 10;
      for (let i = 0; i < batch.length; i += BATCH) {
        const chunk = batch.slice(i, i + BATCH);
        try {
          await _fetchAndStore(chunk);
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
        await _fetchAndStore(batch);
      } catch {
        // Network issue — skip, will retry next cycle
      }
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
    users,
    /** Pre-warm the shared getuserprofile RPC cache for the given addresses.
     *  Call before sequential loops (e.g. decrypt previews) so that all addresses
     *  are fetched in a single batched RPC and subsequent calls hit the cache. */
    async warmProfileCache(addresses: string[]): Promise<void> {
      if (!addresses.length) return;
      const appInit = getAppInit();
      await appInit.initApi();
      await appInit.loadUsersInfoRaw(addresses);
    },
  };
});
