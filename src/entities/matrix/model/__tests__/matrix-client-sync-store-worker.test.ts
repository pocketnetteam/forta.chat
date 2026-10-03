// @vitest-environment happy-dom
/**
 * The Matrix sync store runs in a Web Worker only when the probe says the
 * WebView supports it, and a dropped client's worker is terminated so
 * rebuilt clients (failover, re-init) don't pile up running workers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface FakeStore {
  opts: Record<string, unknown>;
  startup: ReturnType<typeof vi.fn>;
}

interface FakeClient {
  opts: Record<string, unknown>;
  stopClient: ReturnType<typeof vi.fn>;
  store: unknown;
}

const created: FakeClient[] = [];
const stores: FakeStore[] = [];
let workerSupported = false;
const { release, track, startWorker } = vi.hoisted(() => ({
  release: vi.fn(),
  track: vi.fn(),
  startWorker: vi.fn(),
}));

vi.mock("matrix-js-sdk-bastyon/lib/browser-index.js", () => ({
  createClient: vi.fn((opts: Record<string, unknown>) => {
    let logins = 0;
    const client = {
      opts,
      login: vi.fn(async () => ({ user_id: "@u:matrix.example", access_token: `t${++logins}`, device_id: "D" })),
      startClient: vi.fn(async () => {}),
      stopClient: vi.fn(),
      removeAllListeners: vi.fn(),
      createFilter: vi.fn(async () => ({})),
      isUsernameAvailable: vi.fn(async () => false),
      on: vi.fn(),
      off: vi.fn(),
      store: opts.store,
      credentials: { userId: "@u:matrix.example" },
    };
    created.push(client);
    return client;
  }),
  IndexedDBStore: class {
    startup = vi.fn(async () => {});
    constructor(public opts: Record<string, unknown>) {
      stores.push(this as unknown as FakeStore);
    }
  },
  MatrixError: class MatrixError extends Error {},
}));

vi.mock("@/shared/lib/matrix/chat-storage", () => ({
  createChatStorage: vi.fn(async () => ({})),
}));

vi.mock("../sync-store-worker", () => ({
  isSyncStoreWorkerSupported: vi.fn(async () => workerSupported),
  startSyncStoreWorker: startWorker,
  trackSyncStoreWorker: track,
  releaseSyncStoreWorker: release,
}));

import { MatrixClientService } from "../matrix-client";

const userClients = (): FakeClient[] => created.filter((c) => c.opts.accessToken);

function service(): MatrixClientService {
  const s = new MatrixClientService("matrix.example");
  s.setCredentials({ username: "u", password: "p", address: "addr" } as never);
  const internals = s as unknown as { pingServers: () => Promise<string>; ensureWatchdog: () => void };
  internals.pingServers = async () => "matrix.example";
  internals.ensureWatchdog = () => {};
  return s;
}

describe("MatrixClientService — sync store worker", () => {
  beforeEach(() => {
    created.length = 0;
    stores.length = 0;
    release.mockClear();
    track.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("builds the store on the worker when the WebView supports it", async () => {
    workerSupported = true;
    const s = service();
    await s.init();

    expect(stores).toHaveLength(1);
    expect(stores[0].opts.workerFactory).toBe(startWorker);
    expect(stores[0].opts.dbName).toBe("matrix-js-sdk-v7:u");
    expect(track).toHaveBeenCalledWith(stores[0]);
    expect(userClients()[0].store).toBe(stores[0]);
  });

  it("keeps the main-thread store when the WebView can't run the worker", async () => {
    workerSupported = false;
    const s = service();
    await s.init();

    expect(stores).toHaveLength(1);
    expect(stores[0].opts).not.toHaveProperty("workerFactory");
    expect(track).not.toHaveBeenCalled();
  });

  it("releases the previous client's worker when a later init() replaces it", async () => {
    workerSupported = true;
    const s = service();
    await s.init();
    await s.init();

    const [first, second] = userClients();
    expect(first.stopClient).toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(first.store);
    expect(release).not.toHaveBeenCalledWith(second.store);
  });

  it("releases the worker on destroy()", async () => {
    workerSupported = true;
    const s = service();
    await s.init();
    const client = userClients()[0];

    s.destroy();

    expect(release).toHaveBeenCalledWith(client.store);
  });
});
