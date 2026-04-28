import { isNative } from "@/shared/lib/platform";
import { nativeCallBridge } from "@/shared/lib/native-calls";
import { NativeWebRTC } from "@/shared/lib/native-webrtc";

/**
 * Centralized call cleanup. Every termination path (hangup, reject,
 * sdk-ended, error, permission-denied, ice-failed, user-cancel) must go
 * through this single helper so audio resources are reliably released.
 *
 * Idempotent per callId: a duplicate finalize for the same callId within
 * a 30-second GC window is a no-op. Each cleanup step is wrapped so a
 * failure in one does not block the next.
 *
 * Order of operations:
 *   1. stopAudioRouting → audio mode → NORMAL, communication device cleared
 *   2. reportCallEnded → Telecom CallConnection released
 *   3. dismissCallUI → activity finished, foreground service stopped
 *      (this is what abandons audio focus and releases the wake lock)
 *   4. closeAllPeerConnections → AudioSource/AudioTrack disposed,
 *      AudioRecord released so the mic is free for the next call / music
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
const telemetryListeners = new Set<TelemetryListener>();

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

export async function finalizeCall(reason: FinalizeReason, callId: string): Promise<void> {
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

    try {
      emit({ type: "call_finalize_start", reason, callId });

      // Step 1: stop audio routing (mode → NORMAL, clearCommunicationDevice)
      await safeStep("stopAudioRouting", callId, () => nativeCallBridge.stopAudioRouting());

      // Step 2: report call ended → CallConnection cleanup
      await safeStep("reportCallEnded", callId, () => nativeCallBridge.reportCallEnded(callId));

      // Step 3: dismiss UI + stop foreground service (abandons audio focus, releases wake lock)
      if (isNative) {
        await safeStep("dismissCallUI", callId, () => NativeWebRTC.dismissCallUI());
      }

      // Step 4: close peer connections + dispose media (release mic AudioRecord)
      if (isNative) {
        await safeStep("closeAllPeerConnections", callId, () => NativeWebRTC.closeAllPeerConnections());
      }

      emit({ type: "call_finalized", reason, callId });
    } finally {
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
  telemetryListeners.clear();
}
