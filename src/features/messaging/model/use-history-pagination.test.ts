import { describe, it, expect, vi } from "vitest";
import { useHistoryPagination, type HistoryPaginationDeps } from "./use-history-pagination";

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(overrides: Partial<HistoryPaginationDeps> = {}) {
  let activeRoomId: string | null = "!a";
  const deps: HistoryPaginationDeps = {
    getActiveRoomId: () => activeRoomId,
    expandWindow: vi.fn(async () => true),
    loadMoreRemote: vi.fn(async () => true),
    prefetchRemote: vi.fn(async () => true),
    ...overrides,
  };
  const p = useHistoryPagination(deps);
  return { p, deps, switchRoom: (id: string) => { activeRoomId = id; p.reset(); } };
}

describe("useHistoryPagination", () => {
  it("serves scroll-up from Dexie without touching the network when the window fills", async () => {
    const { p, deps } = setup();
    await p.loadMore("!a");
    expect(deps.expandWindow).toHaveBeenCalledTimes(1);
    expect(deps.loadMoreRemote).not.toHaveBeenCalled();
    expect(deps.prefetchRemote).toHaveBeenCalledWith("!a");
  });

  it("falls back to network scrollback only when Dexie is exhausted, then expands again", async () => {
    const expandWindow = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { p, deps } = setup({ expandWindow });
    await p.loadMore("!a");
    expect(deps.loadMoreRemote).toHaveBeenCalledWith("!a");
    expect(expandWindow).toHaveBeenCalledTimes(2);
    expect(p.hasMoreLocal.value).toBe(true);
  });

  // Regression (audit B1): an empty prefetch used to set the single hasMore
  // flag to false and kill scroll-up while Dexie still held older history.
  it("keeps paginating from Dexie after the server reports no more history", async () => {
    const { p, deps } = setup({ prefetchRemote: vi.fn(async () => false) });
    p.startPrefetch("!a");
    await flush();
    expect(p.hasMoreRemote.value).toBe(false);
    expect(p.canLoadMore.value).toBe(true);

    await p.loadMore("!a");
    expect(deps.expandWindow).toHaveBeenCalledTimes(1);
    expect(deps.loadMoreRemote).not.toHaveBeenCalled();
  });

  it("stops only when both Dexie and the server are exhausted", async () => {
    const { p } = setup({
      expandWindow: vi.fn(async () => false),
      loadMoreRemote: vi.fn(async () => false),
    });
    await p.loadMore("!a");
    expect(p.hasMoreLocal.value).toBe(false);
    expect(p.hasMoreRemote.value).toBe(false);
    expect(p.canLoadMore.value).toBe(false);
  });

  // Regression (audit B2): the previous room's prefetch resolving after a
  // switch set hasMore=false for the NEW room.
  it("ignores a prefetch result from the previous room", async () => {
    let resolveOld!: (more: boolean) => void;
    const prefetchRemote = vi.fn<(roomId: string) => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
    const { p, switchRoom } = setup({ prefetchRemote });

    p.startPrefetch("!a");
    switchRoom("!b");
    resolveOld(false);
    await flush();

    expect(p.hasMoreRemote.value).toBe(true);
  });

  it("ignores results after switching away and back (A → B → A)", async () => {
    let resolveOld!: (more: boolean) => void;
    const prefetchRemote = vi.fn<(roomId: string) => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
    const { p, switchRoom } = setup({ prefetchRemote });

    p.startPrefetch("!a");
    switchRoom("!b");
    switchRoom("!a");
    resolveOld(false);
    await flush();

    expect(p.hasMoreRemote.value).toBe(true);
  });

  it("does not run two loads at once and does not leak loading state across rooms", async () => {
    let release!: (v: boolean) => void;
    const expandWindow = vi.fn(() => new Promise<boolean>((r) => { release = r; }));
    const { p, switchRoom } = setup({ expandWindow });

    const first = p.loadMore("!a");
    void p.loadMore("!a");
    expect(expandWindow).toHaveBeenCalledTimes(1);
    expect(p.loadingMore.value).toBe(true);

    switchRoom("!b");
    expect(p.loadingMore.value).toBe(false);
    release(false);
    await first;
    expect(p.hasMoreLocal.value).toBe(true); // stale result dropped
    expect(p.loadingMore.value).toBe(false);
  });
});
