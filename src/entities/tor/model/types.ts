export type TorStatus = "stopped" | "running" | "install" | "started" | "failed";

export type TorMode = "auto" | "always" | "neveruse";

export type TorBridgeType = "none" | "snowflake";

/** Live counters from Service Worker network-stats events */
export interface TorNetworkStats {
  /** Last direct request size (resets after idle) */
  directBytes: number;
  /** Last Tor-routed request size (resets after idle) */
  torBytes: number;
  /** Cumulative direct bytes since SW install */
  totalDirectBytes: number;
  /** Cumulative Tor bytes since SW install */
  totalTorBytes: number;
}

export type TorRequestFlash = "success" | "failed" | null;
