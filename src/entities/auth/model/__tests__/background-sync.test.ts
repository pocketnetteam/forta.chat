import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BackgroundSyncManager } from "../background-sync";
import type { DemoteOptions } from "../background-sync";

function makeSyncResponse(
  rooms: Record<string, number>,
  nextBatch = "batch_2",
) {
  const join: Record<string, unknown> = {};
  for (const [roomId, count] of Object.entries(rooms)) {
    join[roomId] = { unread_notifications: { notification_count: count } };
  }
  return { rooms: { join }, next_batch: nextBatch };
}

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(body),
  });
}

const OPTS: DemoteOptions = {
  address: "addr1",
  accessToken: "tok1",
  homeserverUrl: "https://hs.example.com",
  syncToken: "batch_1",
};

describe("BackgroundSyncManager", () => {
  let mgr: BackgroundSyncManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mgr = new BackgroundSyncManager();
  });

  afterEach(() => {
    mgr.stopAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("demote starts a poller that fetches after 30s", async () => {
    const body = makeSyncResponse({ "!room1:hs": 3 });
    globalThis.fetch = mockFetchOk(body);

    mgr.demote(OPTS);

    // No fetch yet
    expect(globalThis.fetch).not.toHaveBeenCalled();

    // Advance 30s
    await vi.advanceTimersByTimeAsync(30_000);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("fetch URL contains correct /sync endpoint with since token", async () => {
    const body = makeSyncResponse({});
    globalThis.fetch = mockFetchOk(body);

    mgr.demote(OPTS);
    await vi.advanceTimersByTimeAsync(30_000);

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(url).toContain("/_matrix/client/v3/sync");
    expect(url).toContain("timeout=0");
    expect(url).toContain(`since=${encodeURIComponent("batch_1")}`);
  });

  it("unread counts are accumulated correctly from response", async () => {
    const body = makeSyncResponse({
      "!room1:hs": 5,
      "!room2:hs": 3,
      "!room3:hs": 0,
    });
    globalThis.fetch = mockFetchOk(body);

    mgr.demote(OPTS);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mgr.getUnreadCount("addr1")).toBe(8);
  });

  it("promote removes poller and stops fetching", async () => {
    const body = makeSyncResponse({ "!room1:hs": 2 });
    globalThis.fetch = mockFetchOk(body);

    mgr.demote(OPTS);
    mgr.promote("addr1");

    await vi.advanceTimersByTimeAsync(30_000);

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mgr.getUnreadCount("addr1")).toBe(0);
  });

  it("getAllUnreadCounts returns correct map", async () => {
    const body1 = makeSyncResponse({ "!r1:hs": 4 });
    const body2 = makeSyncResponse({ "!r2:hs": 7 });

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      const body = callCount === 1 ? body1 : body2;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    });

    mgr.demote(OPTS);
    mgr.demote({ ...OPTS, address: "addr2", accessToken: "tok2" });

    await vi.advanceTimersByTimeAsync(30_000);

    const counts = mgr.getAllUnreadCounts();
    expect(counts).toEqual({ addr1: 4, addr2: 7 });
  });

  it("setAppState changes interval to background (5min)", async () => {
    const body = makeSyncResponse({});
    globalThis.fetch = mockFetchOk(body);

    mgr.setAppState(false); // background
    mgr.demote(OPTS);

    // 30s should NOT trigger
    await vi.advanceTimersByTimeAsync(30_000);
    expect(globalThis.fetch).not.toHaveBeenCalled();

    // 5min should trigger
    await vi.advanceTimersByTimeAsync(270_000); // total 300s
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("updates sync token from response next_batch", async () => {
    const body1 = makeSyncResponse({ "!r:hs": 1 }, "batch_new");
    const body2 = makeSyncResponse({ "!r:hs": 2 }, "batch_newer");
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call++;
      const body = call === 1 ? body1 : body2;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    });

    mgr.demote(OPTS);

    // First poll
    await vi.advanceTimersByTimeAsync(30_000);

    // Second poll — URL should have new token
    await vi.advanceTimersByTimeAsync(30_000);

    const url2 = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[1][0] as string;
    expect(url2).toContain(`since=${encodeURIComponent("batch_new")}`);
  });

  it("continues polling on fetch error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.reject(new Error("network"));
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(makeSyncResponse({ "!r:hs": 1 }, "batch_2")),
      });
    });

    mgr.demote(OPTS);

    // First poll — error
    await vi.advanceTimersByTimeAsync(30_000);
    expect(warnSpy).toHaveBeenCalled();

    // Second poll — success
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mgr.getUnreadCount("addr1")).toBe(1);

    warnSpy.mockRestore();
  });

  it("reactiveUnreadCounts returns the reactive object", async () => {
    const body = makeSyncResponse({ "!r:hs": 10 });
    globalThis.fetch = mockFetchOk(body);

    mgr.demote(OPTS);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mgr.reactiveUnreadCounts).toEqual({ addr1: 10 });
  });

  it("stopAll stops all pollers", async () => {
    globalThis.fetch = mockFetchOk(makeSyncResponse({}));

    mgr.demote(OPTS);
    mgr.demote({ ...OPTS, address: "addr2" });
    mgr.stopAll();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
