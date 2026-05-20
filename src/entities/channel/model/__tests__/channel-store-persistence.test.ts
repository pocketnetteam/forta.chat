import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useChannelStore } from "../channel-store";
import { useAuthStore } from "@/entities/auth";
import { getChatDb, isChatDbReady } from "@/shared/lib/local-db";
import type { LocalChannel } from "@/shared/lib/local-db";

vi.mock("@/entities/auth", () => ({
  useAuthStore: vi.fn(),
}));

vi.mock("@/shared/lib/local-db", () => ({
  getChatDb: vi.fn(),
  isChatDbReady: vi.fn(),
}));

interface FakeChannelRepo {
  getAll: ReturnType<typeof vi.fn>;
  replaceAll: ReturnType<typeof vi.fn>;
  bulkUpsert: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
}

function makeRepo(stored: LocalChannel[] = []): FakeChannelRepo {
  const state = [...stored];
  return {
    getAll: vi.fn(async () => [...state]),
    replaceAll: vi.fn(async (channels: LocalChannel[]) => {
      state.splice(0, state.length, ...channels);
    }),
    bulkUpsert: vi.fn(async (channels: LocalChannel[]) => {
      for (const c of channels) {
        const idx = state.findIndex((s) => s.address === c.address);
        if (idx >= 0) state[idx] = c;
        else state.push(c);
      }
    }),
    clear: vi.fn(async () => {
      state.length = 0;
    }),
  };
}

describe("channel-store — Dexie hydration + persistence (WEE-24)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(useAuthStore).mockReset();
    vi.mocked(getChatDb).mockReset();
    vi.mocked(isChatDbReady).mockReset();
  });

  // --- A1: cold-start render from Dexie before Pocketnet RPC ---
  it("hydrates the channel list from Dexie before Matrix/RPC fetch returns", async () => {
    const repo = makeRepo([
      {
        address: "addr_1",
        name: "Persisted One",
        avatar: "av1",
        lastContent: null,
        syncOrder: 0,
        updatedAt: 100,
      },
      {
        address: "addr_2",
        name: "Persisted Two",
        avatar: "av2",
        lastContent: null,
        syncOrder: 1,
        updatedAt: 100,
      },
    ]);

    vi.mocked(isChatDbReady).mockReturnValue(true);
    vi.mocked(getChatDb).mockReturnValue({ channels: repo } as never);

    const store = useChannelStore();
    expect(store.channels).toEqual([]);

    await store.hydrateFromDexie();

    expect(repo.getAll).toHaveBeenCalledTimes(1);
    expect(store.channels.map((c) => c.address)).toEqual(["addr_1", "addr_2"]);
    expect(store.channels[0].name).toBe("Persisted One");
    expect(store.isHydrated).toBe(true);
  });

  it("hydrateFromDexie is a no-op when the chat DB is not ready (logged out / tests)", async () => {
    vi.mocked(isChatDbReady).mockReturnValue(false);

    const store = useChannelStore();
    await store.hydrateFromDexie();

    expect(getChatDb).not.toHaveBeenCalled();
    expect(store.channels).toEqual([]);
    expect(store.isHydrated).toBe(false);
  });

  it("does not overwrite an already-populated in-memory list", async () => {
    const repo = makeRepo([
      {
        address: "stale",
        name: "Stale",
        avatar: "",
        lastContent: null,
        syncOrder: 0,
        updatedAt: 0,
      },
    ]);
    vi.mocked(isChatDbReady).mockReturnValue(true);
    vi.mocked(getChatDb).mockReturnValue({ channels: repo } as never);

    const store = useChannelStore();
    store.channels = [
      { address: "fresh", name: "Fresh", avatar: "", lastContent: null },
    ];

    await store.hydrateFromDexie();

    expect(store.channels.map((c) => c.address)).toEqual(["fresh"]);
  });

  it("hydrateFromDexie is idempotent within a session", async () => {
    const repo = makeRepo([
      {
        address: "a",
        name: "A",
        avatar: "",
        lastContent: null,
        syncOrder: 0,
        updatedAt: 0,
      },
    ]);
    vi.mocked(isChatDbReady).mockReturnValue(true);
    vi.mocked(getChatDb).mockReturnValue({ channels: repo } as never);

    const store = useChannelStore();
    await store.hydrateFromDexie();
    await store.hydrateFromDexie();

    expect(repo.getAll).toHaveBeenCalledTimes(1);
  });

  // --- A2: fetchChannels writes to Dexie so the next cold-start is non-empty ---
  it("persists the full set to Dexie after a reset fetch", async () => {
    const repo = makeRepo();
    vi.mocked(isChatDbReady).mockReturnValue(true);
    vi.mocked(getChatDb).mockReturnValue({ channels: repo } as never);

    const fetched = Array.from({ length: 20 }, (_, i) => ({
      address: `addr_${i}`,
      name: `Ch${i}`,
    }));
    vi.mocked(useAuthStore).mockReturnValue({
      address: "me",
      getSubscribesChannels: vi.fn().mockResolvedValueOnce({
        channels: fetched,
        height: 1000,
      }),
    } as unknown as ReturnType<typeof useAuthStore>);

    const store = useChannelStore();
    await store.fetchChannels(true);

    expect(repo.replaceAll).toHaveBeenCalledTimes(1);
    const persisted = repo.replaceAll.mock.calls[0][0] as LocalChannel[];
    expect(persisted).toHaveLength(20);
    expect(persisted[0].address).toBe("addr_0");
    expect(persisted[0].syncOrder).toBe(0);
    expect(persisted[5].syncOrder).toBe(5);
    expect(store.isHydrated).toBe(true);
  });

  it("upserts only the newly appended page on non-reset fetches", async () => {
    const repo = makeRepo();
    vi.mocked(isChatDbReady).mockReturnValue(true);
    vi.mocked(getChatDb).mockReturnValue({ channels: repo } as never);

    const page0 = Array.from({ length: 20 }, (_, i) => ({
      address: `p0_${i}`,
      name: `Ch${i}`,
    }));
    const page1 = Array.from({ length: 20 }, (_, i) => ({
      address: `p1_${i}`,
      name: `Ch${20 + i}`,
    }));
    vi.mocked(useAuthStore).mockReturnValue({
      address: "me",
      getSubscribesChannels: vi
        .fn()
        .mockResolvedValueOnce({ channels: page0, height: 1000 })
        .mockResolvedValueOnce({ channels: page1, height: 1000 }),
    } as unknown as ReturnType<typeof useAuthStore>);

    const store = useChannelStore();
    await store.fetchChannels(true);
    await store.fetchChannels(false);

    expect(repo.replaceAll).toHaveBeenCalledTimes(1);
    expect(repo.bulkUpsert).toHaveBeenCalledTimes(1);
    const appended = repo.bulkUpsert.mock.calls[0][0] as LocalChannel[];
    expect(appended).toHaveLength(20);
    expect(appended[0].address).toBe("p1_0");
    // syncOrder continues from the previous page tail
    expect(appended[0].syncOrder).toBe(20);
    expect(appended[19].syncOrder).toBe(39);
  });

  it("reset fetch does NOT clear the visible list until the RPC response arrives", async () => {
    const repo = makeRepo();
    vi.mocked(isChatDbReady).mockReturnValue(true);
    vi.mocked(getChatDb).mockReturnValue({ channels: repo } as never);

    let resolveRpc: (v: unknown) => void = () => {};
    const rpcPromise = new Promise((resolve) => {
      resolveRpc = resolve;
    });
    vi.mocked(useAuthStore).mockReturnValue({
      address: "me",
      getSubscribesChannels: vi.fn().mockReturnValue(rpcPromise),
    } as unknown as ReturnType<typeof useAuthStore>);

    const store = useChannelStore();
    store.channels = [
      { address: "persisted", name: "Persisted", avatar: "", lastContent: null },
    ];

    const inFlight = store.fetchChannels(true);
    // Still showing the Dexie-hydrated list while RPC is in-flight
    expect(store.channels.map((c) => c.address)).toEqual(["persisted"]);

    resolveRpc({ channels: [{ address: "fresh", name: "Fresh" }], height: 1 });
    await inFlight;

    // Only after RPC resolves the list is replaced by the server view
    expect(store.channels.map((c) => c.address)).toEqual(["fresh"]);
  });

  it("Dexie persistence failure does not break fetchChannels (warn-and-continue)", async () => {
    const repo = makeRepo();
    repo.replaceAll.mockRejectedValueOnce(new Error("db kaput"));
    vi.mocked(isChatDbReady).mockReturnValue(true);
    vi.mocked(getChatDb).mockReturnValue({ channels: repo } as never);

    vi.mocked(useAuthStore).mockReturnValue({
      address: "me",
      getSubscribesChannels: vi.fn().mockResolvedValueOnce({
        channels: [{ address: "a", name: "A" }],
        height: 1,
      }),
    } as unknown as ReturnType<typeof useAuthStore>);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = useChannelStore();
    await expect(store.fetchChannels(true)).resolves.toBeUndefined();
    expect(store.channels.map((c) => c.address)).toEqual(["a"]);
    warn.mockRestore();
  });

  // --- concurrent-fetch dedup (sidebar + child both kick off RPC) ---
  it("dedupes overlapping fetchChannels calls (only one RPC per cold-start)", async () => {
    const repo = makeRepo();
    vi.mocked(isChatDbReady).mockReturnValue(true);
    vi.mocked(getChatDb).mockReturnValue({ channels: repo } as never);

    let resolveRpc: (v: unknown) => void = () => {};
    const rpcPromise = new Promise((resolve) => {
      resolveRpc = resolve;
    });
    const getSubsSpy = vi.fn().mockReturnValue(rpcPromise);
    vi.mocked(useAuthStore).mockReturnValue({
      address: "me",
      getSubscribesChannels: getSubsSpy,
    } as unknown as ReturnType<typeof useAuthStore>);

    const store = useChannelStore();
    // Two parallel kick-offs — one from ChatSidebar.onMounted, one from
    // ChannelList.onMounted that races right behind it.
    const a = store.fetchChannels(true);
    const b = store.fetchChannels(true);

    resolveRpc({ channels: [{ address: "x", name: "X" }], height: 1 });
    await Promise.all([a, b]);

    expect(getSubsSpy).toHaveBeenCalledTimes(1);
    expect(repo.replaceAll).toHaveBeenCalledTimes(1);
  });

  // --- cleanup ---
  it("cleanup resets isHydrated so a fresh login starts clean", async () => {
    const repo = makeRepo([
      {
        address: "a",
        name: "A",
        avatar: "",
        lastContent: null,
        syncOrder: 0,
        updatedAt: 0,
      },
    ]);
    vi.mocked(isChatDbReady).mockReturnValue(true);
    vi.mocked(getChatDb).mockReturnValue({ channels: repo } as never);

    const store = useChannelStore();
    await store.hydrateFromDexie();
    expect(store.isHydrated).toBe(true);

    store.cleanup();
    expect(store.isHydrated).toBe(false);
    expect(store.channels).toEqual([]);
  });
});
