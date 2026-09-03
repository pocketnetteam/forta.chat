/**
 * Homeserver failover primitives for the /sync transport (WEE-105).
 *
 * The Matrix SDK connects to a SINGLE homeserver chosen once at init and never
 * rotates it. When that host is throttled/blocked/overloaded, /sync loops
 * ERROR↔RECONNECTING forever and only a manual reload (a fresh lottery on the
 * same host) recovers — sometimes on the 2nd-3rd try. Media downloads already
 * alternate primary↔mirror (WEE-90); this brings the same resilience to /sync.
 *
 * This module holds the PURE, side-effect-free decision logic so it can be unit
 * tested in isolation. `matrix-client.ts` wires it to axios/SDK/timers.
 */
import { MATRIX_SERVER, MATRIX_MIRRORS } from "@/shared/config/constants";

/** Short per-host probe budget for the boot ping-and-pick (A1/A5). */
export const PING_TIMEOUT_MS = 4_000;

/** Exponential backoff bounds for retrying the SAME host on a sync ERROR.
 *  Replaces the old tight `retryImmediately()` loop (WEE-105 H2). */
export const ERROR_RETRY_BASE_MS = 2_000;
export const ERROR_RETRY_MAX_MS = 30_000;

/** Backoff for rebuilding a Matrix client after `client === null` (total outage). */
export const CLIENT_RECOVERY_BASE_MS = 2_000;
export const CLIENT_RECOVERY_MAX_MS = 60_000;

/** Ordered homeserver hosts for /sync: primary first, then mirrors. */
export const MATRIX_SYNC_HOSTS: readonly string[] = [MATRIX_SERVER, ...MATRIX_MIRRORS];

/** Strip protocol/trailing slash from a base URL → bare host. */
export function hostFromBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** Next host in rotation after `currentHost`, wrapping around. An unknown host
 *  rotates to the first mirror (or stays on primary when no mirrors exist). */
export function nextMatrixHost(currentHost: string, hosts: readonly string[] = MATRIX_SYNC_HOSTS): string {
  const idx = hosts.indexOf(currentHost);
  if (idx === -1) return hosts[hosts.length > 1 ? 1 : 0];
  return hosts[(idx + 1) % hosts.length];
}

/** Resolves `true` when the host answered, `false`/throw when it did not. */
export type HostProbe = (host: string) => Promise<boolean>;

/**
 * Pick the first live homeserver from `[primary, ...mirrors]` with primary
 * priority. The primary is probed first: when it is healthy we return it after
 * a single probe and never wait on mirrors, so a healthy primary keeps the hot
 * path untouched (A5). Only when the primary fails do we walk the mirrors in
 * order. When nothing answers we keep the primary so the normal boot retry path
 * still gets a chance.
 */
export async function pickLiveMatrixHost(
  probe: HostProbe,
  hosts: readonly string[] = MATRIX_SYNC_HOSTS,
): Promise<string> {
  const [primary, ...mirrors] = hosts;
  try {
    if (await probe(primary)) return primary;
  } catch {
    /* primary unreachable — fall through to mirrors */
  }
  for (const mirror of mirrors) {
    try {
      if (await probe(mirror)) return mirror;
    } catch {
      /* try next mirror */
    }
  }
  return primary;
}

/**
 * Probe `hosts` in order and return the first that answers, or `null` when
 * every probe fails. Unlike {@link pickLiveMatrixHost}, this does NOT fall
 * back to primary on total outage — callers use that to defer destructive
 * failover (keep the existing client) instead of destroying it blindly.
 */
export async function findLiveMatrixHost(
  probe: HostProbe,
  hosts: readonly string[],
): Promise<string | null> {
  for (const host of hosts) {
    try {
      if (await probe(host)) return host;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Probe order for a watchdog failover: prefer the rotation target first, then
 * the remaining configured hosts (so we can still land on the current host if
 * only it is reachable again).
 */
export function failoverProbeOrder(
  preferred: string,
  hosts: readonly string[] = MATRIX_SYNC_HOSTS,
): string[] {
  const rest = hosts.filter((h) => h !== preferred);
  return [preferred, ...rest];
}

export interface SyncWatchdogDeps {
  /** Invoked once when the watchdog decides the sync is stuck. */
  onFailover: () => void;
  /** Network reachability gate — never fail over while genuinely offline. */
  isOnline: () => boolean;
  setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface SyncWatchdogConfig {
  /** Consecutive ERROR states (while online) that trigger a failover. */
  maxConsecutiveErrors: number;
  /** No PREPARED/SYNCING for this long while online → trigger a failover.
   *  Kept above the SDK's own reconnect cadence so a transient blip self-heals
   *  before we pay a client recreate. */
  staleTimeoutMs: number;
  /** Cap on consecutive failovers WITHOUT a healthy sync in between. Once hit,
   *  the watchdog stops rotating (a teardown+login every staleTimeout forever
   *  on a permanently-dead network helps nobody) and lets the error banner
   *  take over until a healthy PREPARED/SYNCING resets the counter. */
  maxConsecutiveFailovers: number;
}

export const DEFAULT_WATCHDOG_CONFIG: SyncWatchdogConfig = {
  maxConsecutiveErrors: 4,
  staleTimeoutMs: 300_000,
  maxConsecutiveFailovers: 4,
};

/**
 * Runtime watchdog over the /sync state stream. Fires `onFailover` when the
 * client is online but the sync is wedged — either N consecutive ERROR states
 * or no healthy PREPARED/SYNCING for `staleTimeoutMs`. The stale deadline is
 * anchored to the FIRST unhealthy state and is NOT pushed out on every error
 * (the bug behind the never-clearing banner); only a healthy state clears it.
 */
export class SyncWatchdog {
  private consecutiveErrors = 0;
  private consecutiveFailovers = 0;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private firing = false;
  private stopped = false;

  constructor(
    private readonly deps: SyncWatchdogDeps,
    private readonly config: SyncWatchdogConfig = DEFAULT_WATCHDOG_CONFIG,
  ) {}

  notifySync(state: string): void {
    if (this.stopped || this.firing) return;

    if (state === "PREPARED" || state === "SYNCING") {
      // A healthy sync is the only thing that proves a host is good — reset
      // both the error and the failover budgets here.
      this.consecutiveErrors = 0;
      this.consecutiveFailovers = 0;
      this.clearStaleTimer();
      return;
    }

    // STOPPED is an intentional teardown (logout/stopClient), not a "wedged
    // while online" condition — it must not arm a failover. Only the genuine
    // stuck-transport states (ERROR / RECONNECTING) drive the watchdog.
    if (state === "ERROR" || state === "RECONNECTING") {
      if (state === "ERROR") this.consecutiveErrors += 1;
      // Stop rotating once the failover budget is spent — let the banner show.
      if (this.consecutiveFailovers >= this.config.maxConsecutiveFailovers) return;
      if (this.deps.isOnline() && this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
        this.trigger();
        return;
      }
      this.armStaleTimer();
    }
  }

  private armStaleTimer(): void {
    if (!this.deps.isOnline()) {
      this.clearStaleTimer();
      return;
    }
    // Anchor to the first unhealthy state: do not re-arm while already running.
    if (this.staleTimer !== null) return;
    this.staleTimer = this.deps.setTimer(() => {
      this.staleTimer = null;
      if (this.stopped || this.firing) return;
      if (this.deps.isOnline()) this.trigger();
    }, this.config.staleTimeoutMs);
  }

  private clearStaleTimer(): void {
    if (this.staleTimer !== null) {
      this.deps.clearTimer(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private trigger(): void {
    if (this.firing || this.stopped) return;
    this.firing = true;
    this.consecutiveFailovers += 1;
    this.clearStaleTimer();
    this.consecutiveErrors = 0;
    this.deps.onFailover();
  }

  /** Re-arm after a failover recreate completes so the next mirror is watched
   *  too. The failover budget is NOT reset here — only a healthy sync clears
   *  it — so a permanently-dead network can't loop teardown+login forever. */
  reset(): void {
    this.firing = false;
    this.consecutiveErrors = 0;
    this.clearStaleTimer();
  }

  /**
   * Call when `onFailover` probed hosts and found none live — we kept the
   * existing client. Undo the budget increment from {@link trigger} so a
   * total DNS outage does not burn `maxConsecutiveFailovers`, then re-arm
   * the stale timer so we probe again after `staleTimeoutMs`.
   */
  deferFailover(): void {
    if (this.consecutiveFailovers > 0) this.consecutiveFailovers -= 1;
    this.firing = false;
    this.consecutiveErrors = 0;
    this.clearStaleTimer();
    if (!this.stopped && this.deps.isOnline()) {
      this.armStaleTimer();
    }
  }

  /** Permanently stop (logout / client teardown). */
  stop(): void {
    this.stopped = true;
    this.clearStaleTimer();
  }
}
