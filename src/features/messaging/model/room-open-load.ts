import { withTimeout } from "@/shared/lib/with-timeout";
import { decideRoomOpen, shouldWaitForSyncedMessages, type RoomOpenBranch } from "./room-open-plan";

/** Cached branch: how long to wait for the liveQuery's first emission before
 *  revealing anyway. Only a warning — it never falls through to the network. */
export const ROOM_OPEN_EMISSION_TIMEOUT_MS = 5_000;
/** Network branch: total budget for SDK load + waiting for sync to deliver.
 *  Past it the skeleton gives way to an empty state with "Retry" while the
 *  request keeps running; the liveQuery shows the messages if it lands. */
export const ROOM_OPEN_NETWORK_BUDGET_MS = 8_000;
/** Upper bound on waiting for sync after the SDK load (inside the budget). */
const SYNC_WAIT_MS = 8_000;

export interface RoomOpenLoadDeps {
  /** True once the user switched away (or the open was re-run). */
  isStale: () => boolean;
  /** Rows Dexie holds for the room (a 1-row peek is enough). */
  countLocalRows: () => Promise<number>;
  hasClearedHistory: () => boolean;
  /** Resolves true on the first liveQuery emission for the room, false on timeout. */
  waitForFirstEmission: (timeoutMs: number) => Promise<boolean>;
  /** SDK/server load; resolves to the parsed message count (see loadRoomMessages). */
  loadFromNetwork: () => Promise<number | undefined>;
  /** Resolves when messages appear on screen, or after `timeoutMs`. */
  waitForMessages: (timeoutMs: number) => Promise<void>;
  hasMessages: () => boolean;
  setLoading: (loading: boolean) => void;
  trace?: (step: string, detail?: string | number) => void;
}

export interface RoomOpenLoadResult {
  branch: RoomOpenBranch;
  /** Network branch ran out of budget with nothing to show. */
  networkTimedOut: boolean;
}

/**
 * First-screen load of a room open (plan 2026-09-28, stage 1). Returns null
 * when the open went stale midway. The network is awaited only when Dexie has
 * nothing for the room; background refresh of a cached room is the caller's
 * job and runs after the reveal.
 */
export async function runRoomOpenLoad(deps: RoomOpenLoadDeps): Promise<RoomOpenLoadResult | null> {
  const localRowCount = await deps.countLocalRows();
  if (deps.isStale()) return null;
  deps.trace?.("peek", localRowCount);

  const hasClearedHistory = deps.hasClearedHistory();
  const branch = decideRoomOpen({ localRowCount, hasClearedHistory });
  deps.trace?.("branch", branch);

  if (branch === "empty") return { branch, networkTimedOut: false };

  if (branch === "cached") {
    const emitted = await deps.waitForFirstEmission(ROOM_OPEN_EMISSION_TIMEOUT_MS);
    if (deps.isStale()) return null;
    if (emitted) {
      deps.trace?.("first-emission");
    } else {
      console.warn("[MessageList] room-open: no liveQuery emission within %dms — revealing anyway", ROOM_OPEN_EMISSION_TIMEOUT_MS);
    }
    return { branch, networkTimedOut: false };
  }

  deps.setLoading(true);
  const chain = (async () => {
    let parsedCount: number | undefined;
    try {
      parsedCount = await deps.loadFromNetwork();
    } catch { /* surfaced as an empty room below */ }
    if (deps.isStale() || deps.hasMessages()) return;
    if (shouldWaitForSyncedMessages({ parsedCount, hasClearedHistory })) {
      await deps.waitForMessages(SYNC_WAIT_MS);
    }
  })();

  let networkTimedOut = false;
  try {
    await withTimeout(chain, ROOM_OPEN_NETWORK_BUDGET_MS, "room-open network");
  } catch {
    networkTimedOut = !deps.hasMessages();
  }
  if (deps.isStale()) return null;
  deps.setLoading(false);
  if (networkTimedOut) deps.trace?.("network-timeout");
  return { branch, networkTimedOut };
}
