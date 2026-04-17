/**
 * After an initial loadMessages() with zero messages, MessageList used to wait
 * for Matrix sync in case the SDK timeline was not populated yet.
 * When loadRoomMessages() has already finished (room timeline marked loaded),
 * waiting only blocks the empty state — e.g. server-side retention purged history.
 */
export function shouldWaitForMatrixSyncAfterEmptyInitialLoad(
  hasClearedHistoryTimestamp: boolean,
  roomTimelineLoadedThisSession: boolean,
): boolean {
  return !hasClearedHistoryTimestamp && !roomTimelineLoadedThisSession;
}
