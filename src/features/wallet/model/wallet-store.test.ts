import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { ref } from "vue";

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
