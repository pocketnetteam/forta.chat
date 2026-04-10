import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// ── Mocks ─────────────────────────────────────────────────────────

const mockLoadUsersBatch = vi.fn((_addrs: string[]) => Promise.resolve());
const mockInitApi = vi.fn(() => Promise.resolve());
const mockGetUserData = vi.fn((_addr: string) => ({
  name: "TestUser",
  about: "",
  image: "",
  site: "",
  language: "",
}));

vi.mock("@/app/providers/initializers/app-initializer", () => ({
  createAppInitializer: () => ({
    loadUsersBatch: mockLoadUsersBatch,
    initApi: mockInitApi,
    getUserData: mockGetUserData,
    loadUserData: vi.fn(([addr]: string[]) => ({
      name: "TestUser",
      about: "",
      image: "",
      site: "",
      language: "",
    })),
  }),
}));

vi.mock("@/entities/auth/model/stores", () => {
  const _address = { value: "PMyOwnAddress123456789012345678901" };
  const _regPending = { value: false };
  return {
    useAuthStore: () => ({
      address: _address.value,
      registrationPending: _regPending.value,
    }),
    __setMockAddress: (addr: string) => { _address.value = addr; },
    __setMockRegPending: (val: boolean) => { _regPending.value = val; },
  };
});

// Re-import the test helpers for controlling mock state
const authMockModule = await import("@/entities/auth/model/stores") as any;

import { useUserStore } from "./user-store";

describe("loadUsersBatch — own address separation", () => {
  let store: ReturnType<typeof useUserStore>;
  const MY_ADDR = "PMyOwnAddress123456789012345678901";
  const OTHER1 = "POtherAddress1xxxxxxxxxxxxxxxxxxx";
  const OTHER2 = "POtherAddress2xxxxxxxxxxxxxxxxxxx";

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    store = useUserStore();
    authMockModule.__setMockAddress(MY_ADDR);
    authMockModule.__setMockRegPending(false);
  });

  it("loads other addresses without own address in the same batch", async () => {
    await store.loadUsersBatch([OTHER1, MY_ADDR, OTHER2]);

    // loadUsersBatch should have been called at least twice:
    // once for others, once for self
    expect(mockLoadUsersBatch).toHaveBeenCalled();
    const calls = mockLoadUsersBatch.mock.calls;
    const allBatches = calls.map(c => c[0]);

    // Own address should never appear in the same batch as others
    for (const batch of allBatches) {
      if (batch.includes(MY_ADDR)) {
        expect(batch).toEqual([MY_ADDR]);
      }
    }

    // Both others should be in one batch (no own address mixed in)
    const otherBatch = allBatches.find(b => b.includes(OTHER1));
    expect(otherBatch).toBeDefined();
    expect(otherBatch).not.toContain(MY_ADDR);
  });

  it("sets cachedAt for normal profiles", async () => {
    await store.loadUsersBatch([OTHER1]);

    const user = store.users[OTHER1];
    expect(user).toBeDefined();
    expect(user?.cachedAt).toBeGreaterThan(0);
  });

  it("skips cachedAt during registration for own address", async () => {
    authMockModule.__setMockRegPending(true);

    await store.loadUsersBatch([MY_ADDR]);

    const user = store.users[MY_ADDR];
    expect(user).toBeDefined();
    expect(user?.cachedAt).toBeUndefined();
  });

  it("sets cachedAt for own address when NOT registering", async () => {
    authMockModule.__setMockRegPending(false);

    await store.loadUsersBatch([MY_ADDR]);

    const user = store.users[MY_ADDR];
    expect(user).toBeDefined();
    expect(user?.cachedAt).toBeGreaterThan(0);
  });

  it("skips already-cached addresses (TTL-aware)", async () => {
    // Pre-populate cache with a fresh entry
    store.setUser(OTHER1, {
      address: OTHER1,
      name: "Cached",
      about: "",
      image: "",
      site: "",
      language: "",
      cachedAt: Date.now(),
    });

    await store.loadUsersBatch([OTHER1]);

    // Should NOT have called loadUsersBatch on the API since it's fresh
    expect(mockLoadUsersBatch).not.toHaveBeenCalled();
  });

  it("re-fetches own address during registration even if cached", async () => {
    authMockModule.__setMockRegPending(true);

    // Pre-populate with cached own profile
    store.setUser(MY_ADDR, {
      address: MY_ADDR,
      name: "OldName",
      about: "",
      image: "",
      site: "",
      language: "",
      cachedAt: Date.now(),
    });

    await store.loadUsersBatch([MY_ADDR]);

    // Should have fetched despite cache being fresh
    expect(mockLoadUsersBatch).toHaveBeenCalled();
    const calls = mockLoadUsersBatch.mock.calls;
    const hasSelfCall = calls.some(c => c[0].includes(MY_ADDR));
    expect(hasSelfCall).toBe(true);
  });
});

describe("USER_TTL_MS = 7 days", () => {
  it("user-store source uses 7-day TTL", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(resolve(__dirname, "user-store.ts"), "utf-8");
    expect(source).toContain("7 * 24 * 60 * 60 * 1000");
  });
});
