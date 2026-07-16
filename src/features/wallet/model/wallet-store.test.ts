import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { ref } from "vue";
import { formatPkoin } from "./wallet-store";
import { makeUTXO } from "@/test-utils";

// --- Mocks ---

const mockAddress = ref<string | null>("PAddr1");
const mockIsAuthenticated = ref(true);

vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({
    get address() { return mockAddress.value; },
    get isAuthenticated() { return mockIsAuthenticated.value; },
  }),
}));

const mockRpc = vi.fn();

vi.mock("@/shared/api/sdk-bridge", () => ({
  getPocketnetInstance: () => ({
    user: { address: { value: mockAddress.value } },
  }),
}));

import { useWalletStore } from "./wallet-store";

describe("wallet-store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockAddress.value = "PAddr1";
    mockIsAuthenticated.value = true;
    mockRpc.mockReset();

    // Must use `function` (not arrow) so `new Api(...)` works as constructor
    vi.stubGlobal("bitcoin", {});
    vi.stubGlobal("Api", vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this.initIf = vi.fn().mockResolvedValue(undefined);
      this.wait = { ready: vi.fn().mockResolvedValue(undefined) };
      this.rpc = mockRpc;
    }));
  });

  it("fetches balance for current address", async () => {
    mockRpc.mockResolvedValue({ balance: 42.5 });

    const store = useWalletStore();
    await store.refresh();

    expect(store.balance).toBe(42.5);
    expect(store.status).toBe("ready");
    expect(mockRpc).toHaveBeenCalledWith("getaddressinfo", ["PAddr1"]);
  });

  it("discards stale response after account switch", async () => {
    let resolveRpc!: (v: unknown) => void;
    mockRpc.mockImplementation(
      () => new Promise((resolve) => { resolveRpc = resolve; }),
    );

    const store = useWalletStore();
    const refreshPromise = store.refresh();

    // Let getApi() microtasks settle so rpc is actually called
    await new Promise((r) => setTimeout(r, 0));

    // Simulate account switch: reset before RPC resolves
    store.reset();

    // Now resolve the stale RPC
    resolveRpc({ balance: 100 });
    await refreshPromise;

    // Balance should remain null because generation was bumped by reset()
    expect(store.balance).toBeNull();
    expect(store.status).toBe("idle");
  });

  it("sets error status on RPC failure", async () => {
    mockRpc.mockRejectedValue(new Error("network down"));

    const store = useWalletStore();
    await store.refresh();

    expect(store.status).toBe("error");
    expect(store.error).toBe("network down");
    expect(store.balance).toBeNull();
  });

  it("isAvailable returns false when no address", () => {
    mockAddress.value = null;
    const store = useWalletStore();
    expect(store.isAvailable).toBe(false);
  });

  it("isAvailable returns true when authenticated with address", () => {
    const store = useWalletStore();
    expect(store.isAvailable).toBe(true);
  });

  it("isStale returns true initially and false after refresh", async () => {
    mockRpc.mockResolvedValue({ balance: 1 });
    const store = useWalletStore();
    expect(store.isStale).toBe(true);
    await store.refresh();
    expect(store.isStale).toBe(false);
  });

  it("startPolling triggers periodic refresh", async () => {
    vi.useFakeTimers();
    mockRpc.mockResolvedValue({ balance: 5 });

    const store = useWalletStore();
    store.startPolling(100);

    await vi.advanceTimersByTimeAsync(100);
    expect(mockRpc).toHaveBeenCalled();

    store.stopPolling();
    vi.useRealTimers();
  });

  it("reset clears all state", async () => {
    mockRpc.mockResolvedValue({ balance: 10 });

    const store = useWalletStore();
    await store.refresh();
    expect(store.balance).toBe(10);
    expect(store.status).toBe("ready");

    store.reset();

    expect(store.balance).toBeNull();
    expect(store.status).toBe("idle");
    expect(store.error).toBeNull();
    expect(store.updatedAt).toBeNull();
  });
});

describe("wallet-store UTXO cache (WEE-72)", () => {
  // Count only the txunspent calls — refresh()/getApi also hit mockRpc.
  const txCalls = () => mockRpc.mock.calls.filter((c) => c[0] === "txunspent");

  const respondWith = (utxos: unknown) => {
    mockRpc.mockImplementation((method: string) =>
      method === "txunspent" ? Promise.resolve(utxos) : Promise.resolve({ balance: 1 }),
    );
  };

  beforeEach(() => {
    setActivePinia(createPinia());
    mockAddress.value = "PAddr1";
    mockIsAuthenticated.value = true;
    mockRpc.mockReset();
    vi.stubGlobal("bitcoin", {});
    vi.stubGlobal(
      "Api",
      vi.fn().mockImplementation(function (this: Record<string, unknown>) {
        this.initIf = vi.fn().mockResolvedValue(undefined);
        this.wait = { ready: vi.fn().mockResolvedValue(undefined) };
        this.rpc = mockRpc;
      }),
    );
  });

  it("serves a fresh cache without hitting the network again", async () => {
    respondWith([makeUTXO()]);
    const store = useWalletStore();

    const first = await store.getUtxos();
    const second = await store.getUtxos();

    expect(first).toBe(second);
    expect(txCalls()).toHaveLength(1);
  });

  it("force-refetches when asked", async () => {
    respondWith([makeUTXO()]);
    const store = useWalletStore();

    await store.getUtxos();
    await store.getUtxos({ force: true });

    expect(txCalls()).toHaveLength(2);
  });

  it("falls back to a valid cache when a refresh fails", async () => {
    respondWith([makeUTXO({ amountSat: 5000 })]);
    const store = useWalletStore();
    const cached = await store.getUtxos();

    // Next (forced) fetch fails with a non-timeout error.
    mockRpc.mockImplementation((method: string) =>
      method === "txunspent"
        ? Promise.reject({ code: -6, message: "bad request" })
        : Promise.resolve({ balance: 1 }),
    );

    const result = await store.getUtxos({ force: true });
    expect(result).toEqual(cached);
  });

  it("keeps a non-empty cache when the node returns an empty answer", async () => {
    respondWith([makeUTXO({ amountSat: 5000 })]);
    const store = useWalletStore();
    const cached = await store.getUtxos();

    respondWith([]); // node glitch
    const result = await store.getUtxos({ force: true });

    expect(result).toEqual(cached);
  });

  it("throws when the fetch fails and there is no cache", async () => {
    mockRpc.mockImplementation((method: string) =>
      method === "txunspent"
        ? Promise.reject({ code: -6, message: "bad request" })
        : Promise.resolve({ balance: 1 }),
    );
    const store = useWalletStore();

    await expect(store.getUtxos()).rejects.toMatchObject({ code: -6 });
  });

  it("invalidateUtxos forces the next call to re-fetch", async () => {
    respondWith([makeUTXO()]);
    const store = useWalletStore();

    await store.getUtxos();
    store.invalidateUtxos();
    await store.getUtxos();

    expect(txCalls()).toHaveLength(2);
  });

  it("reset clears the UTXO cache", async () => {
    respondWith([makeUTXO()]);
    const store = useWalletStore();

    await store.getUtxos();
    store.reset();
    await store.getUtxos();

    expect(txCalls()).toHaveLength(2);
  });

  it("does not cache a stale result when reset() runs during an in-flight fetch", async () => {
    let resolveTx!: (v: unknown) => void;
    mockRpc.mockImplementation((method: string) =>
      method === "txunspent"
        ? new Promise((r) => { resolveTx = r; })
        : Promise.resolve({ balance: 1 }),
    );

    const store = useWalletStore();
    const inflight = store.getUtxos();
    await new Promise((r) => setTimeout(r, 0)); // let getApi() settle, rpc fires

    store.reset(); // account switch bumps the generation
    resolveTx([makeUTXO({ amountSat: 1000 })]);
    await inflight;

    // The stale single-UTXO result must not have been cached; the next call
    // re-fetches and sees the fresh two-UTXO set.
    respondWith([makeUTXO(), makeUTXO()]);
    const fresh = await store.getUtxos();
    expect(fresh).toHaveLength(2);
  });
});

describe("formatPkoin", () => {
  it("returns '0' for null/undefined/zero/negative", () => {
    expect(formatPkoin(null)).toBe("0");
    expect(formatPkoin(undefined)).toBe("0");
    expect(formatPkoin(0)).toBe("0");
    expect(formatPkoin(-1)).toBe("0");
  });

  it("uses 2 decimals for >= 1", () => {
    expect(formatPkoin(42.5)).toBe("42.50");
    expect(formatPkoin(1)).toBe("1.00");
    expect(formatPkoin(1000.123)).toBe("1000.12");
  });

  it("uses up to 4 decimals for 0.0005–0.9999", () => {
    expect(formatPkoin(0.5)).toBe("0.5");
    expect(formatPkoin(0.0006)).toBe("0.0006");
    expect(formatPkoin(0.001)).toBe("0.001");
    expect(formatPkoin(0.1234)).toBe("0.1234");
  });

  it("uses up to 8 decimals for < 0.0005", () => {
    expect(formatPkoin(0.0001)).toBe("0.0001");
    expect(formatPkoin(0.00000050)).toBe("0.0000005");
    expect(formatPkoin(0.00000001)).toBe("0.00000001");
  });
});
