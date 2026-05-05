import { CryptoNotReadyError } from "@/shared/lib/network/typed-network-errors";
import type { PcryptoRoomInstance } from "./matrix-crypto";

/** Polling cadence for waitForRoomCrypto. 100ms is short enough that a
 *  fast Matrix sync (which usually settles within a few hundred ms after
 *  login) returns immediately, and long enough that we don't burn CPU in
 *  hot-loop while the worker thread is still parsing key payloads. */
const POLL_INTERVAL_MS = 100;

/** Default upper bound — long enough to ride out a slow cold start on Tor /
 *  3G while still failing fast enough that the user sees a clear error
 *  rather than an indefinite spinner. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Wait until `getRoom()` returns a usable PcryptoRoomInstance, or throw
 *  `CryptoNotReadyError` after `timeoutMs` elapses.
 *
 *  The download/decrypt pipeline races against Matrix sync immediately
 *  after login: the user opens a chat with E2E media before
 *  `authStore.pcrypto.rooms[roomId]` has been populated by the room-add
 *  callback. Without this helper the first decrypt attempt threw a bare
 *  `Error("No room crypto for decryption")` (issue #616) and the user had
 *  to manually pull-to-refresh once sync caught up. With it, the call
 *  parks for up to a few hundred ms — typically invisible to the user —
 *  and then proceeds once the room instance materialises.
 *
 *  `getRoom` is invoked on every poll instead of being captured once,
 *  because `authStore.pcrypto?.rooms[roomId]` is what we want to observe
 *  and a captured reference would never see the population. */
export async function waitForRoomCrypto(
  roomId: string,
  getRoom: () => PcryptoRoomInstance | undefined,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PcryptoRoomInstance> {
  const deadline = Date.now() + timeoutMs;
  // First check is synchronous so the happy path doesn't pay a tick.
  const immediate = getRoom();
  if (immediate) return immediate;

  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const room = getRoom();
    if (room) return room;
  }

  throw new CryptoNotReadyError(roomId);
}
