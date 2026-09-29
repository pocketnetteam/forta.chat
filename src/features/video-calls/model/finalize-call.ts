import { isAndroid } from "@/shared/lib/platform";
import { nativeCallBridge, retirePendingMarkers } from "@/shared/lib/native-calls";
import { NativeWebRTC } from "@/shared/lib/native-webrtc";
import { withTimeout } from "@/shared/lib/with-timeout";
import { releasePageAwake } from "./page-awake-tone";

/**
 * Centralized call cleanup. Every termination path (hangup, reject,
 * sdk-ended, error, permission-denied, ice-failed, user-cancel) must go
 * through this single helper so audio resources are reliably released.
 *
 * Idempotent per callId: a duplicate finalize for the same callId within
 * a 30-second GC window is a no-op. Each cleanup step is wrapped so a
 * failure in one does not block the next.
 *
 * Every step below is process-wide on native (the audio mode, the foreground
 * service, the PeerConnections), so a call dialled while a finalize is still
 * between its steps would have the rest of them land on itself. `hasLiveCall`
 * drops the moment the SDK call ends, before this runs; the dial path waits
 * on [waitForFinalizeSettled] so that the two never overlap.
 *
 * Order of operations:
 *   0. retirePendingMarkers → the queued answer/reject for this call can no
 *      longer reach the next invite from the same room. First, so the
 *      bridge's ordering guard is armed before the slower steps run.
 *   1. stopAudioRouting → audio mode → NORMAL, communication device cleared
 *   2. reportCallEnded → Telecom CallConnection released
 *   3. dismissCallUI → activity finished, foreground service stopped
 *      (this is what abandons audio focus and releases the wake lock)
 *   4. closeAllPeerConnections → AudioSource/AudioTrack disposed,
 *      AudioRecord released so the mic is free for the next call / music
 *   5. releasePageAwake → this call no longer keeps the page audible, so a
 *      hidden page may be frozen again (see page-awake-tone.ts)
 *
 * Without step 4 in particular, a leaked AudioRecord can lock the
 * microphone for the whole device until the OS process is killed.
 */

export type FinalizeReason =
  | "hangup"
  | "reject"
  | "sdk-ended"
  | "error"
  | "permission-denied"
  | "ice-failed"
  | "user-cancel"
  | "watchdog-timeout";

export interface CallTelemetryEvent {
  type: "call_finalize_start" | "call_finalized";
  reason: FinalizeReason;
  callId: string;
}

type TelemetryListener = (event: CallTelemetryEvent) => void;

const FINALIZE_GC_MS = 30_000;
// `null` value means "in progress, not yet GC-eligible". Once finalize
// completes (any outcome — success or all steps failed), the entry is
// rearmed with a real GC timeout so a fresh call with the same callId
// can re-finalize after the GC window passes.
const finalizedCalls = new Map<string, ReturnType<typeof setTimeout> | null>();
/** Finalizes whose steps are still running, by callId. */
const inFlight = new Map<string, Promise<void>>();
const telemetryListeners = new Set<TelemetryListener>();

/**
 * How long a dial waits for the previous call's finalize. The steps are a few
 * native round trips, milliseconds when the page is awake; the bound only
 * keeps a native step that never answers from holding the dial forever.
 */
export const FINALIZE_SETTLE_WAIT_MS = 2000;

function emit(event: CallTelemetryEvent): void {
  for (const listener of telemetryListeners) {
    try {
      listener(event);
    } catch (e) {
      console.warn("[finalize-call] telemetry listener threw:", e);
    }
  }
}

async function safeStep(name: string, callId: string, step: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await step();
  } catch (e) {
    console.warn(`[finalize-call] ${name} failed for ${callId}:`, e);
  }
}

export async function finalizeCall(
  reason: FinalizeReason,
  callId: string,
  roomId?: string,
): Promise<void> {
  // Outer try/catch ensures a sync throw (e.g. broken bridge import,
  // listener loop bug) cannot escape as an unhandled promise rejection.
  try {
    if (!callId) {
      console.warn("[finalize-call] missing callId, skipping cleanup (reason=" + reason + ")");
      return;
    }
    if (finalizedCalls.has(callId)) {
      console.log("[finalize-call] duplicate finalize for " + callId + " (reason=" + reason + "), skipping");
      return;
    }
    // Reserve idempotency slot synchronously, before any await — a
    // second concurrent finalizeCall for the same callId must see the
    // slot occupied. We park `null` in the map for the duration of the
    // cleanup; the real GC timer is armed only after all steps run.
    // This avoids the race where a slow cleanup (>30s) had its slot
    // GC'd while still in progress, allowing a re-entry to restart
    // step 1 and double-cleanup audio routing.
    finalizedCalls.set(callId, null);

    const run = runSteps(reason, callId, roomId);
    inFlight.set(callId, run);
    try {
      await run;
    } finally {
      inFlight.delete(callId);
      // Arm the GC timer only after all steps complete. Until this point
      // the slot stayed `null` (in-progress); a 30-second-too-late
      // duplicate would have been blocked from re-running step 1.
      const gcTimer = setTimeout(() => {
        finalizedCalls.delete(callId);
      }, FINALIZE_GC_MS);
      finalizedCalls.set(callId, gcTimer);
    }
  } catch (e) {
    console.warn("[finalize-call] unexpected sync error:", e);
  }
}

/** The cleanup steps in order; never rejects, every step is isolated. */
async function runSteps(reason: FinalizeReason, callId: string, roomId?: string): Promise<void> {
  try {
    emit({ type: "call_finalize_start", reason, callId });

    // Step 0: retire this call's pending answer/reject markers. They exist
    // to carry a decision across a process that was not alive to act on it;
    // reaching here means JS has acted. Left behind, a marker matches the
    // NEXT invite from the same room and either auto-answers it with no
    // ringer or declines it unheard — both seen on the Samsung bench,
    // 2026-09-09. Runs on every termination path, because every one of them
    // comes through here, and runs FIRST so the bridge's ordering guard is
    // armed before the slower native steps below.
    //
    // roomId matters as much as callId: a connection created from a push
    // is keyed by the push's call_id, which this homeserver fills with the
    // event_id, so its marker can never be matched by the Matrix callId
    // that arrives here. The room is the only key the two paths share.
    await safeStep("retirePendingMarkers", callId, () => retirePendingMarkers(callId, roomId));

    // Step 1: stop audio routing (mode → NORMAL, clearCommunicationDevice)
    await safeStep("stopAudioRouting", callId, () => nativeCallBridge.stopAudioRouting());

    // Step 2: report call ended → CallConnection cleanup
    await safeStep("reportCallEnded", callId, () => nativeCallBridge.reportCallEnded(callId));

    // Step 3: dismiss UI + stop foreground service (abandons audio focus,
    // releases wake lock). Named, so native stops the service against this
    // call's own start generation: issued after the next call's launchCallUI,
    // an unnamed stop matched the current generation and ended that call.
    // Steps 3 and 4 are NativeWebRTC's, an Android-only plugin: on iOS both
    // rejected with UNIMPLEMENTED on every call.
    if (isAndroid) {
      await safeStep("dismissCallUI", callId, () => NativeWebRTC.dismissCallUI({ callId }));
    }

    // Step 4: close peer connections + dispose media (release mic AudioRecord).
    // Named: reaching native after the next call's launchCallUI, this close
    // would take the new call's connections down with the old one's.
    if (isAndroid) {
      await safeStep("closeAllPeerConnections", callId, () => NativeWebRTC.closeAllPeerConnections({ callId }));
    }

    // Step 5: let the page fall silent. The tone kept Chromium from freezing
    // the page behind the native call screen, and every step above waits on
    // a native reply that a frozen page would never receive.
    await safeStep("releasePageAwake", callId, () => releasePageAwake(callId));

    emit({ type: "call_finalized", reason, callId });
  } catch (e) {
    console.warn("[finalize-call] unexpected error in cleanup steps:", e);
  }
}

/**
 * Resolves once no finalize is running, or after `timeoutMs`. Returns whether
 * they all settled. Finalizes that start during the wait are waited for too.
 */
export async function waitForFinalizeSettled(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    try {
      await withTimeout(Promise.all([...inFlight.values()]), remaining, "finalize-settle");
    } catch {
      return false;
    }
  }
  return true;
}

/** Test-only: whether a finalize is still between its steps. */
export function __hasFinalizeInFlightForTests(): boolean {
  return inFlight.size > 0;
}

/**
 * Force-reset audio state without a specific callId. Used by the
 * app-resume watchdog when the device is stuck in MODE_IN_COMMUNICATION
 * and no call is live (typically because a previous call's finalize
 * never ran — JS process killed, OEM stopped the foreground service).
 */
export async function forceResetAudioState(): Promise<void> {
  await safeStep("forceStopAudio", "<no-call>", () => nativeCallBridge.forceStopAudio());
}

export function onCallTelemetry(listener: TelemetryListener): () => void {
  telemetryListeners.add(listener);
  return () => {
    telemetryListeners.delete(listener);
  };
}

/** Test-only: clear the in-memory finalized-callId set between tests. */
export function __resetFinalizeCallStateForTests(): void {
  for (const timer of finalizedCalls.values()) {
    if (timer) clearTimeout(timer);
  }
  finalizedCalls.clear();
  inFlight.clear();
  telemetryListeners.clear();
}
