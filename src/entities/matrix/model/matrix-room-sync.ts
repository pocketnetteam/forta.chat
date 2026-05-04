/** Lookup function — typically `client.getRoom.bind(client)`. */
type GetRoomFn = (roomId: string) => unknown;

/**
 * Wait until a room appears in the matrix-js-sdk room store.
 *
 * Used after `createRoom` to avoid the race between the local store's
 * optimistic `addRoom` and the SDK's first `/sync` that delivers the new
 * room state. Without this, `fullRoomRefresh` may drop the optimistic
 * entry — see `preservePendingRooms` for the read-side safety net.
 *
 * Implementation is a simple poll with a fast path for the case where the
 * room is already present (covers the homeserver echoing the create response
 * before we get here). The poll interval is configurable so the test suite
 * can drive it with fake timers.
 *
 * @returns the SDK Room object once available
 * @throws Error('waitForRoomInSdk timeout for ${roomId}') after timeoutMs
 */
export function waitForRoomInSdk(
  getRoom: GetRoomFn,
  roomId: string,
  timeoutMs = 5000,
  pollIntervalMs = 100,
): Promise<unknown> {
  const immediate = getRoom(roomId);
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const room = getRoom(roomId);
      if (room) {
        clearInterval(interval);
        resolve(room);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        clearInterval(interval);
        reject(new Error(`waitForRoomInSdk timeout for ${roomId}`));
      }
    }, pollIntervalMs);
  });
}
