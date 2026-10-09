// @vitest-environment happy-dom
/**
 * Boot shortcuts in MatrixClientService: a page reload reuses the session
 * (no /login), the live host (no /versions ping) and the uploaded sync filter
 * (no POST /filter) from earlier runs, and a token the server rejects is
 * replaced by a password re-login through the SDK's tokenRefreshFunction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface FakeStore {
  startup: ReturnType<typeof vi.fn>;
  storeFilter: ReturnType<typeof vi.fn>;
  setFilterIdByName: ReturnType<typeof vi.fn>;
}

interface FakeClient {
  opts: Record<string, unknown>;
  login: ReturnType<typeof vi.fn>;
  startClient: ReturnType<typeof vi.fn>;
  createFilter: ReturnType<typeof vi.fn>;
  store: FakeStore | Record<string, never>;
}

const created: FakeClient[] = [];
const stores: FakeStore[] = [];
const events: string[] = [];
let loginImpl: () => Promise<unknown>;

vi.mock("matrix-js-sdk-bastyon/lib/browser-index.js", () => ({
  createClient: vi.fn((opts: Record<string, unknown>) => {
    const client = {
      opts,
      login: vi.fn(() => {
        events.push("login");
        return loginImpl();
      }),
      startClient: vi.fn(async () => {}),
      stopClient: vi.fn(),
      removeAllListeners: vi.fn(),
      createFilter: vi.fn(async () => ({ filterId: "new-filter" })),
      isUsernameAvailable: vi.fn(async () => false),
      on: vi.fn(),
      off: vi.fn(),
      store: (opts.store as FakeStore | undefined) ?? {},
      credentials: { userId: "@u:matrix.example" },
    };
    created.push(client);
    return client;
  }),
  IndexedDBStore: class {
    startup = vi.fn(async () => {
      events.push("store-startup");
    });
    storeFilter = vi.fn();
    setFilterIdByName = vi.fn();
    constructor() {
      stores.push(this as unknown as FakeStore);
    }
  },
  Filter: {
    fromJson: (userId: string, filterId: string, definition: unknown) => ({ userId, filterId, definition }),
  },
  MatrixError: class MatrixError extends Error {},
}));

vi.mock("@/shared/lib/matrix/chat-storage", () => ({
  createChatStorage: vi.fn(async () => ({})),
}));

import { MatrixClientService } from "../matrix-client";
import { MATRIX_SYNC_HOSTS } from "../sync-failover";
import { storeDeviceId } from "../device-id-storage";
import {
  MATRIX_BOOT_CACHE_TTL_MS,
  readCachedMatrixSession,
  readCachedSyncFilterId,
  writeCachedMatrixHost,
  writeCachedMatrixSession,
  writeCachedSyncFilterId,
} from "../matrix-session-cache";

const ADDRESS = "addr";
const LOGIN = { user_id: "@u:matrix.example", access_token: "fresh-token", device_id: "DEV" };

const userClients = (): FakeClient[] => created.filter((c) => c.opts.accessToken);
const logins = (): number => created.reduce((n, c) => n + c.login.mock.calls.length, 0);

function service(ping = vi.fn(async () => MATRIX_SYNC_HOSTS[0])) {
  const s = new MatrixClientService(MATRIX_SYNC_HOSTS[0]);
  s.setCredentials({ username: "u", password: "p", address: ADDRESS } as never);
  const internals = s as unknown as { pingServers: () => Promise<string>; ensureWatchdog: () => void };
  internals.pingServers = ping;
  internals.ensureWatchdog = () => {};
  return { s, ping };
}

describe("MatrixClientService — boot caches", () => {
  beforeEach(() => {
    created.length = 0;
    stores.length = 0;
    events.length = 0;
    localStorage.clear();
    loginImpl = async () => LOGIN;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  describe("session", () => {
    it("skips /login when a session from the last 3 days is cached", async () => {
      writeCachedMatrixSession(ADDRESS, { userId: "@u:matrix.example", accessToken: "cached-token", deviceId: "DEV" });
      storeDeviceId(ADDRESS, "DEV");
      const { s } = service();

      await s.init();

      expect(logins()).toBe(0);
      expect(userClients()).toHaveLength(1);
      expect(userClients()[0].opts).toMatchObject({ accessToken: "cached-token", deviceId: "DEV", userId: "@u:matrix.example" });
      expect(s.isReady()).toBe(true);
    });

    it("logs in and caches the session when the cached one is older than 3 days", async () => {
      writeCachedMatrixSession(
        ADDRESS,
        { userId: "@u:matrix.example", accessToken: "old-token", deviceId: "DEV" },
        Date.now() - MATRIX_BOOT_CACHE_TTL_MS - 1,
      );
      const { s } = service();

      await s.init();

      expect(logins()).toBe(1);
      expect(userClients()[0].opts.accessToken).toBe("fresh-token");
      expect(readCachedMatrixSession(ADDRESS)?.accessToken).toBe("fresh-token");
    });

    it("does not reuse a session issued to another device", async () => {
      writeCachedMatrixSession(ADDRESS, { userId: "@u:matrix.example", accessToken: "cached-token", deviceId: "OTHER" });
      storeDeviceId(ADDRESS, "DEV");
      const { s } = service();

      await s.init();

      expect(logins()).toBe(1);
    });

    it("re-logs in once when the SDK reports the token rejected, and caches the new token", async () => {
      writeCachedMatrixSession(ADDRESS, { userId: "@u:matrix.example", accessToken: "revoked", deviceId: "DEV" });
      const { s } = service();
      await s.init();
      const opts = userClients()[0].opts;
      const refresh = opts.tokenRefreshFunction as (rt: string) => Promise<{ accessToken: string; refreshToken: string }>;
      expect(opts.refreshToken).toEqual(expect.any(String));

      // Several requests hit 401 together: one login serves them all.
      const [a, b] = await Promise.all([refresh(opts.refreshToken as string), refresh(opts.refreshToken as string)]);

      expect(logins()).toBe(1);
      expect(a.accessToken).toBe("fresh-token");
      expect(b).toEqual(a);
      expect(readCachedMatrixSession(ADDRESS)?.accessToken).toBe("fresh-token");
    });

    it("fails the refresh (SDK then reports logout) when the account was deactivated", async () => {
      writeCachedMatrixSession(ADDRESS, { userId: "@u:matrix.example", accessToken: "revoked", deviceId: "DEV" });
      const { s } = service();
      await s.init();
      const opts = userClients()[0].opts;
      const refresh = opts.tokenRefreshFunction as (rt: string) => Promise<unknown>;
      loginImpl = async () => {
        throw new Error("M_USER_DEACTIVATED");
      };

      await expect(refresh("x")).rejects.toThrow(/deactivated/);
      expect(readCachedMatrixSession(ADDRESS)).toBeNull();
    });

    it("opens the sync store while /login is still in flight", async () => {
      let releaseLogin: (v: unknown) => void = () => {};
      loginImpl = () => new Promise((r) => { releaseLogin = r; });
      const { s } = service();

      const pending = s.init();
      for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0));
      expect(events).toEqual(["login", "store-startup"]);
      expect(userClients()).toHaveLength(0);

      releaseLogin(LOGIN);
      await pending;
      expect(userClients()).toHaveLength(1);
      expect(userClients()[0].opts.store).toBe(stores[0]);
    });
  });

  describe("host", () => {
    it("uses the cached live host without pinging, and pings on a retry", async () => {
      const cachedHost = MATRIX_SYNC_HOSTS[MATRIX_SYNC_HOSTS.length - 1];
      writeCachedMatrixHost(cachedHost);
      const { s, ping } = service();

      await s.init();
      expect(ping).not.toHaveBeenCalled();
      expect(userClients()[0].opts.baseUrl).toBe(`https://${cachedHost}`);

      await s.init();
      expect(ping).toHaveBeenCalledTimes(1);
    });

    it("pings when nothing is cached", async () => {
      const { s, ping } = service();
      await s.init();
      expect(ping).toHaveBeenCalledTimes(1);
    });
  });

  describe("sync filter", () => {
    it("reuses the cached filter id without POST /filter and seeds the SDK store", async () => {
      // Learn the definition the client uploads, then start again from cache.
      const first = service();
      await first.s.init();
      const definition = userClients()[0].createFilter.mock.calls[0][0];
      expect(readCachedSyncFilterId(ADDRESS, definition)).toBe("new-filter");

      writeCachedSyncFilterId(ADDRESS, definition, "cached-filter");
      created.length = 0;
      stores.length = 0;
      const second = service();
      await second.s.init();

      const client = userClients()[0];
      expect(client.createFilter).not.toHaveBeenCalled();
      const store = client.store as FakeStore;
      expect(store.storeFilter).toHaveBeenCalledWith(expect.objectContaining({ filterId: "cached-filter" }));
      expect(store.setFilterIdByName).toHaveBeenCalledWith("FILTER_SYNC_@u:matrix.example", "cached-filter");
      expect(client.startClient).toHaveBeenCalledWith(
        expect.objectContaining({ filter: expect.objectContaining({ filterId: "cached-filter" }) }),
      );
    });
  });
});
