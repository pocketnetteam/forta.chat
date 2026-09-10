import { describe, it, expect } from "vitest";
import { isCacheLikelyStale, shouldWaitForSyncedMessages } from "./room-open-plan";

describe("shouldWaitForSyncedMessages (audit C2)", () => {
  it("does not keep the skeleton over a genuinely empty room", () => {
    expect(shouldWaitForSyncedMessages({ parsedCount: 0, hasClearedHistory: false })).toBe(false);
  });

  it("waits while parsed messages are still being written to Dexie", () => {
    expect(shouldWaitForSyncedMessages({ parsedCount: 12, hasClearedHistory: false })).toBe(true);
  });

  it("waits when the room was not loaded from the SDK at all", () => {
    expect(shouldWaitForSyncedMessages({ parsedCount: undefined, hasClearedHistory: false })).toBe(true);
  });

  it("never waits after a clear-history", () => {
    expect(shouldWaitForSyncedMessages({ parsedCount: undefined, hasClearedHistory: true })).toBe(false);
  });
});

describe("isCacheLikelyStale (audit C3)", () => {
  const base = { legacyCacheAgeMs: 0, staleThresholdMs: 60_000 };

  it("flags the Dexie cache as stale while the catch-up sync runs", () => {
    expect(isCacheLikelyStale({ ...base, usingDexie: true, initialSyncStatus: "loading" })).toBe(true);
  });

  it("treats the Dexie cache as current once sync is ready or degraded", () => {
    expect(isCacheLikelyStale({ ...base, usingDexie: true, initialSyncStatus: "ready" })).toBe(false);
    expect(isCacheLikelyStale({ ...base, usingDexie: true, initialSyncStatus: "degraded" })).toBe(false);
  });

  it("keeps the age threshold for the legacy localStorage cache", () => {
    expect(isCacheLikelyStale({ ...base, usingDexie: false, initialSyncStatus: "ready", legacyCacheAgeMs: 61_000 })).toBe(true);
    expect(isCacheLikelyStale({ ...base, usingDexie: false, initialSyncStatus: "loading", legacyCacheAgeMs: 1_000 })).toBe(false);
  });
});
