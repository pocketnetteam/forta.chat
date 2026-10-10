/**
 * The two call-scoped timers of the call service: the incoming-call ring timeout (#10) and the
 * connecting watchdog (H3). Split out of call-service.ts; arm* replace the inline
 * `id = setTimeout(() => { id = null; ... })` pattern with the same order of steps.
 */

// ---------------------------------------------------------------------------
// Incoming call timeout (#10)
// ---------------------------------------------------------------------------

let incomingTimeoutId: ReturnType<typeof setTimeout> | null = null;

export function clearIncomingTimeout() {
  if (incomingTimeoutId !== null) {
    clearTimeout(incomingTimeoutId);
    incomingTimeoutId = null;
  }
}

// ---------------------------------------------------------------------------
// Connecting watchdog (H3)
// ---------------------------------------------------------------------------

/**
 * If `call.answer()` resolves but `onState→Connected` never fires (SDK
 * wedged on peer-connection setup, OEM audio init deadlock, network
 * partition during ICE), the UI sits in "connecting..." forever. Users
 * perceive this as the call "crashing" (#268, #309). Force-fail after
 * 30s with full teardown so the store clears and the user can try again.
 */
export const CONNECTING_WATCHDOG_MS = 30_000;

let connectingWatchdogId: ReturnType<typeof setTimeout> | null = null;

export function clearConnectingWatchdog() {
  if (connectingWatchdogId !== null) {
    clearTimeout(connectingWatchdogId);
    connectingWatchdogId = null;
  }
}

/** Start the incoming-call ring timeout; the id is cleared before `onTimeout` runs. */
export function armIncomingTimeout(onTimeout: () => void, ms: number): void {
  incomingTimeoutId = setTimeout(() => {
    incomingTimeoutId = null;
    onTimeout();
  }, ms);
}

/** Start the connecting watchdog; the id is cleared before `onTimeout` runs. */
export function armConnectingWatchdog(onTimeout: () => void, ms: number): void {
  connectingWatchdogId = setTimeout(() => {
    connectingWatchdogId = null;
    onTimeout();
  }, ms);
}
