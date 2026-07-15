import { describe, it, expect } from "vitest";
import {
  applyNetworkStatsEvent,
  resetCurrentNetworkStats,
  type NetworkStatsEvent,
} from "./network-stats";
import type { TorNetworkStats } from "../model/types";

const EMPTY: TorNetworkStats = {
  directBytes: 0,
  torBytes: 0,
  totalDirectBytes: 0,
  totalTorBytes: 0,
};

describe("applyNetworkStatsEvent", () => {
  it("updates current direct bytes on successful non-Tor request", () => {
    const event: NetworkStatsEvent = {
      status: "success",
      torUsed: false,
      bytesLength: 1024,
      totalStats: { directBytes: 4096, totalTorBytes: 2048 },
    };

    const result = applyNetworkStatsEvent(EMPTY, event);
    expect(result.directBytes).toBe(1024);
    expect(result.torBytes).toBe(0);
    expect(result.totalDirectBytes).toBe(4096);
    expect(result.totalTorBytes).toBe(2048);
  });

  it("updates current Tor bytes when torUsed is true", () => {
    const event: NetworkStatsEvent = {
      status: "success",
      torUsed: true,
      bytesLength: 512,
      totalStats: { directBytes: 100, totalTorBytes: 3000 },
    };

    const result = applyNetworkStatsEvent(EMPTY, event);
    expect(result.torBytes).toBe(512);
    expect(result.directBytes).toBe(0);
    expect(result.totalTorBytes).toBe(3000);
  });

  it("preserves totals when totalStats is missing", () => {
    const current: TorNetworkStats = {
      directBytes: 10,
      torBytes: 20,
      totalDirectBytes: 100,
      totalTorBytes: 200,
    };
    const event: NetworkStatsEvent = {
      status: "failed",
      torUsed: true,
      bytesLength: 0,
    };

    const result = applyNetworkStatsEvent(current, event);
    expect(result.totalDirectBytes).toBe(100);
    expect(result.totalTorBytes).toBe(200);
    expect(result.torBytes).toBe(0);
  });
});

describe("resetCurrentNetworkStats", () => {
  it("clears current counters but keeps totals", () => {
    const current: TorNetworkStats = {
      directBytes: 50,
      torBytes: 75,
      totalDirectBytes: 500,
      totalTorBytes: 750,
    };

    const result = resetCurrentNetworkStats(current);
    expect(result.directBytes).toBe(0);
    expect(result.torBytes).toBe(0);
    expect(result.totalDirectBytes).toBe(500);
    expect(result.totalTorBytes).toBe(750);
  });
});
