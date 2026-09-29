import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runRoomOpenLoad,
  ROOM_OPEN_EMISSION_TIMEOUT_MS,
  ROOM_OPEN_NETWORK_BUDGET_MS,
  type RoomOpenLoadDeps,
} from "./room-open-load";

/** Deps with a controllable liveQuery emission and network load. */
function makeDeps(overrides: Partial<RoomOpenLoadDeps> = {}) {
  let messagesShown = false;
  const loading: boolean[] = [];
  const deps: RoomOpenLoadDeps = {
    isStale: () => false,
    countLocalRows: async () => 0,
    hasClearedHistory: () => false,
    waitForFirstEmission: async () => true,
    loadFromNetwork: vi.fn(async () => 5),
    waitForMessages: async () => {},
    hasMessages: () => messagesShown,
    setLoading: (v) => { loading.push(v); },
    ...overrides,
  };
  return {
    deps,
    loading,
    showMessages: () => { messagesShown = true; },
  };
}

describe("runRoomOpenLoad — cached branch", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("waits for a slow first emission without touching the network", async () => {
    const loadFromNetwork = vi.fn(async () => 5);
    const { deps, loading } = makeDeps({
      countLocalRows: async () => 1,
      loadFromNetwork,
      // liveQuery stuck behind write transactions for 3s (the Android case)
      waitForFirstEmission: () => new Promise((r) => setTimeout(() => r(true), 3_000)),
    });

    const pending = runRoomOpenLoad(deps);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(loadFromNetwork).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ branch: "cached", networkTimedOut: false });
    expect(loadFromNetwork).not.toHaveBeenCalled();
    expect(loading).toEqual([]); // never flips loading → scroller never hidden
  });

  it("reveals after the emission timeout instead of falling back to the network", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loadFromNetwork = vi.fn(async () => 5);
    const { deps } = makeDeps({
      countLocalRows: async () => 3,
      loadFromNetwork,
      waitForFirstEmission: (ms) => new Promise((r) => setTimeout(() => r(false), ms)),
    });

    const pending = runRoomOpenLoad(deps);
    await vi.advanceTimersByTimeAsync(ROOM_OPEN_EMISSION_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({ branch: "cached", networkTimedOut: false });
    expect(loadFromNetwork).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("runRoomOpenLoad — network branch", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("gives up after the budget with a retry state when the load never finishes", async () => {
    const { deps, loading } = makeDeps({
      loadFromNetwork: () => new Promise<number | undefined>(() => {}), // hangs (30s axios timeouts)
    });

    const pending = runRoomOpenLoad(deps);
    await vi.advanceTimersByTimeAsync(ROOM_OPEN_NETWORK_BUDGET_MS);

    await expect(pending).resolves.toEqual({ branch: "network", networkTimedOut: true });
    expect(loading).toEqual([true, false]);
  });

  it("does not report a timeout when messages arrived meanwhile", async () => {
    const { deps, showMessages } = makeDeps({
      loadFromNetwork: () => new Promise<number | undefined>(() => {}),
    });

    const pending = runRoomOpenLoad(deps);
    await vi.advanceTimersByTimeAsync(1_000);
    showMessages(); // live sync wrote the room into Dexie
    await vi.advanceTimersByTimeAsync(ROOM_OPEN_NETWORK_BUDGET_MS);

    await expect(pending).resolves.toEqual({ branch: "network", networkTimedOut: false });
  });

  it("waits for sync inside the budget after a successful load", async () => {
    const waitForMessages = vi.fn(() => new Promise<void>(() => {}));
    const { deps } = makeDeps({ loadFromNetwork: async () => 12, waitForMessages });

    const pending = runRoomOpenLoad(deps);
    await vi.advanceTimersByTimeAsync(ROOM_OPEN_NETWORK_BUDGET_MS);

    await expect(pending).resolves.toEqual({ branch: "network", networkTimedOut: true });
    expect(waitForMessages).toHaveBeenCalledTimes(1);
  });

  it("finishes at once for a genuinely empty room", async () => {
    const waitForMessages = vi.fn(async () => {});
    const { deps } = makeDeps({ loadFromNetwork: async () => 0, waitForMessages });

    await expect(runRoomOpenLoad(deps)).resolves.toEqual({ branch: "network", networkTimedOut: false });
    expect(waitForMessages).not.toHaveBeenCalled();
  });
});

describe("runRoomOpenLoad — empty and stale", () => {
  it("shows the empty state for a cleared room without loading", async () => {
    const loadFromNetwork = vi.fn(async () => 0);
    const { deps, loading } = makeDeps({ hasClearedHistory: () => true, loadFromNetwork });

    await expect(runRoomOpenLoad(deps)).resolves.toEqual({ branch: "empty", networkTimedOut: false });
    expect(loadFromNetwork).not.toHaveBeenCalled();
    expect(loading).toEqual([]);
  });

  it("returns null when the user switched away during the peek", async () => {
    let stale = false;
    const { deps } = makeDeps({
      isStale: () => stale,
      countLocalRows: async () => { stale = true; return 4; },
    });

    await expect(runRoomOpenLoad(deps)).resolves.toBeNull();
  });

  it("leaves loading alone when the open went stale during the network load", async () => {
    let stale = false;
    const { deps, loading } = makeDeps({
      isStale: () => stale,
      loadFromNetwork: async () => { stale = true; return 5; },
    });

    await expect(runRoomOpenLoad(deps)).resolves.toBeNull();
    expect(loading).toEqual([true]); // the newer open owns the flag now
  });
});
