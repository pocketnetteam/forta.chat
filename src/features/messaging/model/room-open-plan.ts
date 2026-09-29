/**
 * Decisions taken by MessageList while opening a room with no messages on
 * screen yet. Kept pure so the timing-sensitive watcher stays testable.
 */

/** How a room open gets its first screen of messages.
 *  - `cached`: Dexie has rows — show them, the network is never on the path.
 *  - `network`: nothing local — load from the SDK/server under a time budget.
 *  - `empty`: nothing local and history was cleared — show the empty state. */
export type RoomOpenBranch = "cached" | "network" | "empty";

/**
 * Pick the room-open branch from what Dexie actually holds (a 1-row peek),
 * not from whether the liveQuery managed to answer within a timeout: a slow
 * read behind a queue of write transactions used to send a fully cached room
 * down the network path and park it on a skeleton.
 */
export function decideRoomOpen(opts: {
  localRowCount: number;
  hasClearedHistory: boolean;
}): RoomOpenBranch {
  if (opts.localRowCount > 0) return "cached";
  if (opts.hasClearedHistory) return "empty";
  return "network";
}

/**
 * After the network load of a room with nothing in the local cache: keep the
 * skeleton up while sync delivers messages into Dexie?
 *
 * `parsedCount` is how many messages loadRoomMessages parsed from the SDK
 * timeline (undefined = it never got that far, e.g. room not in the SDK yet).
 * Zero parsed means the room is genuinely empty — waiting the full sync
 * budget only kept a skeleton over an empty chat for 8 seconds.
 */
export function shouldWaitForSyncedMessages(opts: {
  parsedCount: number | undefined;
  hasClearedHistory: boolean;
}): boolean {
  if (opts.hasClearedHistory) return false;
  return opts.parsedCount !== 0;
}

/**
 * Should the "refreshing" indicator show over cached messages while a
 * background reload runs?
 *
 * With Dexie, live sync writes every room's events as they arrive, so the
 * local cache is only behind while the catch-up sync is still running —
 * that is the signal. (Cache age was never available on this path: the
 * Dexie branch of loadCachedMessages always returned 0, so the indicator
 * never showed.) The legacy localStorage cache keeps its age threshold.
 */
export function isCacheLikelyStale(opts: {
  usingDexie: boolean;
  initialSyncStatus: "loading" | "ready" | "degraded";
  legacyCacheAgeMs: number;
  staleThresholdMs: number;
}): boolean {
  if (opts.usingDexie) return opts.initialSyncStatus === "loading";
  return opts.legacyCacheAgeMs > opts.staleThresholdMs;
}
