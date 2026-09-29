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

/** How often `ensure` is re-attempted while polling. The room instance is
 *  created from the SDK's Room object, which matrix-js-sdk materializes
 *  lazily — an ensure that found nothing at t=0 can succeed at t=2s, so one
 *  attempt is not enough. 1s keeps the retries cheap (each no-op ensure is a
 *  map lookup plus an SDK getRoom) without flooding the network path that a
 *  successful ensure takes. */
const ENSURE_RETRY_INTERVAL_MS = 1_000;

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
 *  and a captured reference would never see the population.
 *
 *  `ensure` makes the wait ACTIVE rather than merely observational. Polling
 *  alone only works when something else is already on its way to registering
 *  the room, and in the common failure mode nothing is: the only code that
 *  populates `pcrypto.rooms` needs the SDK's Room object, so when the SDK
 *  has not materialized the room the instance never appears and the poll is
 *  guaranteed to time out no matter how long it runs. `ensure` (typically
 *  `chatStore.ensureRoomCrypto`) attempts the registration itself, retried
 *  on the cadence above so it also catches the room arriving mid-wait.
 *  It is best-effort: failures are swallowed and the poll continues, so a
 *  transient error inside ensure cannot mask the room appearing by some
 *  other route. */
export async function waitForRoomCrypto(
  roomId: string,
  getRoom: () => PcryptoRoomInstance | undefined,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ensure?: () => Promise<PcryptoRoomInstance | undefined>,
): Promise<PcryptoRoomInstance> {
  const deadline = Date.now() + timeoutMs;
  // First check is synchronous so the happy path doesn't pay a tick.
  const immediate = getRoom();
  if (immediate) return immediate;

  // Kicked off but never awaited inline: `ensure` can hit the network for peer
  // keys, and awaiting it would let a hung call outlive `timeoutMs` and hang
  // the caller's spinner indefinitely — the exact failure the deadline exists
  // to bound. The poll loop stays the only thing that decides when to give up,
  // and picks the instance up either from `getRoom()` (ensure populates the
  // map) or from `ensured` (its return value), whichever lands first.
  let ensured: PcryptoRoomInstance | undefined;
  // Serialized: a slow ensure must not be re-entered by the next poll tick,
  // because two concurrent registrations of the same room would race each
  // other's `prepare()`.
  let ensureInFlight = false;
  let lastEnsureAt = 0;
  const kickEnsure = (): void => {
    if (!ensure || ensureInFlight) return;
    ensureInFlight = true;
    lastEnsureAt = Date.now();
    void (async () => {
      try {
        ensured = await ensure();
      } catch {
        // Best-effort: a failed ensure must not mask the room arriving by
        // some other route, so the poll simply continues.
      } finally {
        ensureInFlight = false;
      }
    })();
  };

  kickEnsure();

  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const room = getRoom() ?? ensured;
    if (room) return room;
    if (Date.now() - lastEnsureAt >= ENSURE_RETRY_INTERVAL_MS) kickEnsure();
  }

  throw new CryptoNotReadyError(roomId);
}
