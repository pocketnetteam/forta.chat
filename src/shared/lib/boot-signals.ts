// ---------------------------------------------------------------------------
// Boot signals — lightweight cross-layer boot lifecycle notifications (WEE-97)
//
// Lets low-priority boot work (recovery table scans, Tor daemon start,
// telemetry collection) wait until the chat list is interactive instead of
// competing with the critical boot path for CPU and IndexedDB throughput.
//
// Lives in `shared` so both `shared/lib/local-db` (consumer) and
// `entities/chat` (producer) can use it without violating FSD layering.
// ---------------------------------------------------------------------------

let chatsInteractiveResolved = false;
let resolveChatsInteractive: () => void = () => {};
let chatsInteractivePromise = createSignal();

function createSignal(): Promise<void> {
  chatsInteractiveResolved = false;
  return new Promise<void>((resolve) => {
    resolveChatsInteractive = () => {
      chatsInteractiveResolved = true;
      resolve();
    };
  });
}

/**
 * Mark the chat list as interactive — the first sync-driven room refresh has
 * been kicked off and roomsInitialized released the skeletons (or the
 * degraded watchdog did). The refresh itself may still be writing in chunks;
 * consumers that must avoid that write burst add their own settle delay.
 * Idempotent; never resets — re-logins within one app lifetime resolve
 * immediately, so deferral only applies to the cold-boot path where it
 * matters.
 */
export function signalChatsInteractive(): void {
  if (chatsInteractiveResolved) return;
  resolveChatsInteractive();
}

/** True once the chats-interactive signal has fired. */
export function isChatsInteractive(): boolean {
  return chatsInteractiveResolved;
}

/**
 * Resolve when the chat list becomes interactive, or after `fallbackMs` —
 * whichever comes first. The fallback guarantees deferred work still runs
 * when the signal never fires (user parked on the login page, Matrix boot
 * failure, etc.). Note: a fallback-path resolution does NOT flip
 * isChatsInteractive() — "deferred work may run" ≠ "chats are interactive".
 */
export function whenChatsInteractive(fallbackMs: number): Promise<void> {
  if (chatsInteractiveResolved) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, fallbackMs);
    chatsInteractivePromise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Test-only: reset the singleton signal between test cases. */
export function __resetBootSignalsForTests(): void {
  chatsInteractivePromise = createSignal();
}
