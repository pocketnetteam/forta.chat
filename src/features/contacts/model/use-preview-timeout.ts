import { reactive, getCurrentScope, onScopeDispose } from "vue";

// Cap the preview decryption skeleton: after this long we stop showing an
// indefinite shimmer and surface a "🔒 Encrypted message" label instead. The
// background decryption keeps retrying and will replace it once decrypted.
export const PREVIEW_DECRYPT_TIMEOUT_MS = 10_000;

/**
 * Per-room preview-decrypt timeout tracking (WEE-96 A4).
 *
 * - `noteResolving(roomId)` arms a one-shot timer; when it fires, the room is
 *   marked timed-out (reactive → the row re-renders skeleton → label once).
 * - `noteReady(roomId)` cancels a pending timer when the preview decrypts
 *   BEFORE the timeout — without this, the timer still fired after success
 *   and the reactive Set mutation re-rendered the row a second time for no
 *   visible change.
 * - A room that DID time out stays timed-out: a later encrypted preview shows
 *   the label immediately instead of re-entering the skeleton phase, so a
 *   late decrypt success is a single label → text transition.
 */
export function usePreviewTimeout(timeoutMs: number = PREVIEW_DECRYPT_TIMEOUT_MS) {
  const timedOut = reactive(new Set<string>());
  // Plain Map — timers are bookkeeping, not render state
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function noteResolving(roomId: string): void {
    if (timedOut.has(roomId) || timers.has(roomId)) return;
    timers.set(roomId, setTimeout(() => {
      timers.delete(roomId);
      timedOut.add(roomId); // reactive → preview re-renders as the label
    }, timeoutMs));
  }

  function noteReady(roomId: string): void {
    const timer = timers.get(roomId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(roomId);
    }
  }

  function isTimedOut(roomId: string): boolean {
    return timedOut.has(roomId);
  }

  function dispose(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  if (getCurrentScope()) onScopeDispose(dispose);

  return { noteResolving, noteReady, isTimedOut, dispose };
}
