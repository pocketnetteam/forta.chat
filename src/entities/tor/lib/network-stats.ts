import type { TorNetworkStats } from "../model/types";

export const CURRENT_STATS_RESET_MS = 2000;
export const REQUEST_FLASH_MS = 300;

export interface NetworkStatsTotal {
  directBytes?: number;
  totalTorBytes?: number;
  torBytes?: number;
}

export interface NetworkStatsEvent {
  status: "success" | "failed";
  url?: string;
  torUsed?: boolean;
  bytesLength?: number;
  totalStats?: NetworkStatsTotal;
}

export function applyNetworkStatsEvent(
  current: TorNetworkStats,
  event: NetworkStatsEvent,
): TorNetworkStats {
  const bytes = event.bytesLength ?? 0;
  const totals = event.totalStats;

  const next: TorNetworkStats = {
    directBytes: current.directBytes,
    torBytes: current.torBytes,
    totalDirectBytes: totals?.directBytes ?? current.totalDirectBytes,
    totalTorBytes: totals?.totalTorBytes ?? current.totalTorBytes,
  };

  if (event.torUsed) {
    next.torBytes = bytes;
  } else if (event.status === "success") {
    next.directBytes = bytes;
  }

  return next;
}

export function resetCurrentNetworkStats(stats: TorNetworkStats): TorNetworkStats {
  return {
    ...stats,
    directBytes: 0,
    torBytes: 0,
  };
}
