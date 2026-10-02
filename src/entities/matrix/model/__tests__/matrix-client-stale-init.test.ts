// @vitest-environment happy-dom
/**
 * Regression: two Matrix clients synced side by side after a slow start. connectMatrixWithRetry gives each
 * init() 45 s, and a timeout does not stop the attempt: its login kept waiting, the retry started a client,
 * and when the first login finally returned that attempt started a second client with its own /sync loop.
 * Every incoming call then created two SDK calls and two native peer connections (Samsung over a VPN,
 * `vpn-ice-in1`; reproduced by holding the first login request for 60 s, `slow-login2`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface FakeClient {
  opts: Record<string, unknown>;
  login: ReturnType<typeof vi.fn>;
  startClient: ReturnType<typeof vi.fn>;
  stopClient: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  createFilter: ReturnType<typeof vi.fn>;
  isUsernameAvailable: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  store: Record<string, unknown>;
  credentials: { userId: string };
  getProfileInfo?: unknown;
}

const created: FakeClient[] = [];
let loginImpl: () => Promise<unknown> = async () => ({});

vi.mock("matrix-js-sdk-bastyon/lib/browser-index.js", () => ({
  createClient: vi.fn((opts: Record<string, unknown>) => {
    const client: FakeClient = {
      opts,
      login: vi.fn(() => loginImpl()),
      startClient: vi.fn(async () => {}),
      stopClient: vi.fn(),
      removeAllListeners: vi.fn(),
      createFilter: vi.fn(async () => ({})),
      isUsernameAvailable: vi.fn(async () => false),
      on: vi.fn(),
      off: vi.fn(),
      store: {},
      credentials: { userId: "@u:matrix.example" },
    };
    created.push(client);
    return client;
  }),
  IndexedDBStore: class {
    startup = vi.fn(async () => {});
  },
  MatrixError: class MatrixError extends Error {},
}));

vi.mock("@/shared/lib/matrix/chat-storage", () => ({
  createChatStorage: vi.fn(async () => ({})),
}));

import { MatrixClientService } from "../matrix-client";

const userClients = (): FakeClient[] => created.filter((c) => c.opts.accessToken);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

function service(): MatrixClientService {
  const s = new MatrixClientService("matrix.example");
  s.setCredentials({ username: "u", password: "p", address: "addr" } as never);
  const internals = s as unknown as { pingServers: () => Promise<string>; ensureWatchdog: () => void };
  internals.pingServers = async () => "matrix.example";
  internals.ensureWatchdog = () => {};
  return s;
}

describe("MatrixClientService — a superseded init() does not start its own client", () => {
  beforeEach(() => {
    created.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("keeps one syncing client when the timed-out attempt's login returns after the retry started", async () => {
    let releaseFirstLogin: (value: unknown) => void = () => {};
    let logins = 0;
    loginImpl = () => {
      logins++;
      const data = { user_id: "@u:matrix.example", access_token: `t${logins}`, device_id: "D" };
      if (logins === 1) return new Promise((r) => { releaseFirstLogin = () => r(data); });
      return Promise.resolve(data);
    };
    const s = service();

    const timedOut = s.init();
    await flush();
    await s.init();

    expect(userClients()).toHaveLength(1);
    const retryClient = userClients()[0];
    expect(s.client).toBe(retryClient);
    expect(s.isReady()).toBe(true);

    releaseFirstLogin(undefined);
    await timedOut;
    await flush();

    const started = userClients().filter((c) => c.startClient.mock.calls.length > 0 && c.stopClient.mock.calls.length === 0);
    expect(started).toEqual([retryClient]);
    expect(s.client).toBe(retryClient);
    expect(s.isReady()).toBe(true);
  });

  it("stops the running client when a later init() installs a new one", async () => {
    // The auth store gave up after three timed-out attempts, the last one then succeeded late, and the
    // reconnect retry (network back) runs init() again on top of that client.
    let logins = 0;
    loginImpl = async () => {
      logins++;
      return { user_id: "@u:matrix.example", access_token: `t${logins}`, device_id: "D" };
    };
    const s = service();

    await s.init();
    const first = userClients()[0];
    await s.init();
    const second = userClients()[1];

    expect(s.client).toBe(second);
    expect(first.stopClient).toHaveBeenCalled();
    expect(second.stopClient).not.toHaveBeenCalled();
  });

  it("does not clear a client that a recovery build installed while init() was logging in", async () => {
    let releaseFirstLogin: (value: unknown) => void = () => {};
    let logins = 0;
    loginImpl = () => {
      logins++;
      const data = { user_id: "@u:matrix.example", access_token: `t${logins}`, device_id: "D" };
      if (logins === 1) return new Promise((r) => { releaseFirstLogin = () => r(data); });
      return Promise.resolve(data);
    };
    const s = service();
    const internals = s as unknown as { getClient: () => Promise<unknown> };

    const pending = s.init();
    await flush();
    // The watchdog failover rebuilds the client in the meantime.
    const rebuilt = await internals.getClient();
    expect(s.client).toBe(rebuilt);

    releaseFirstLogin(undefined);
    await pending;
    await flush();

    expect(s.client).toBe(rebuilt);
  });

  it("does not let the superseded attempt's failure mark the running client as failed", async () => {
    let failFirstLogin: (e: Error) => void = () => {};
    let logins = 0;
    loginImpl = () => {
      logins++;
      if (logins === 1) return new Promise((_r, reject) => { failFirstLogin = reject; });
      return Promise.resolve({ user_id: "@u:matrix.example", access_token: "t2", device_id: "D" });
    };
    const s = service();

    const timedOut = s.init();
    await flush();
    await s.init();
    expect(s.isReady()).toBe(true);

    // The login fails and the username is taken, so getClient() throws in the superseded attempt.
    failFirstLogin(new Error("connection reset"));
    await timedOut;
    await flush();

    expect(s.isReady()).toBe(true);
    expect(s.error).toBe(false);
  });
});
