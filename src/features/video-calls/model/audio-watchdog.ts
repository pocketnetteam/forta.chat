import { App as CapApp } from "@capacitor/app";
import { isNative } from "@/shared/lib/platform";
import { nativeCallBridge } from "@/shared/lib/native-calls";
import { useCallStore } from "@/entities/call";

/**
 * App-resume audio watchdog. Detects when the device is stuck in
 * MODE_IN_COMMUNICATION without an active call (which usually means a
 * previous call's cleanup did not complete — e.g. JS process was killed
 * mid-call, OEM kicked the foreground service, an exception interrupted
 * AudioRouter.stop()) and forces a full audio reset.
 *
 * Without this watchdog the device's audio mode stays in VoIP mode after
 * a crash: music plays at low volume through the earpiece, new calls
 * have zero-way audio, and only an app/device reboot recovers.
 */

let listenerAttached = false;

export async function setupAudioWatchdog(): Promise<void> {
  if (listenerAttached) return;
  if (!isNative) return;
  listenerAttached = true;

  await CapApp.addListener("appStateChange", async (state) => {
    // Only act on resume — a backgrounded app naturally relinquishes
    // audio focus, so checking on background is meaningless.
    if (!state.isActive) return;

    try {
      const callStore = useCallStore();
      // Gate on BOTH activeCall and matrixCall. There is a window during
      // call setup where the SDK has a MatrixCall but `activeCall` is
      // still null (e.g. handleIncomingCall on native skips setActiveCall
      // until the user actually answers). Without the matrixCall gate
      // a watchdog tick during that window would forceStopAudio under a
      // call that is mid-setup — exactly the regression the watchdog is
      // meant to prevent.
      if (callStore.activeCall || callStore.matrixCall) return;

      const status = await nativeCallBridge.getAudioStatus();
      if (status.mode !== "MODE_IN_COMMUNICATION") return;

      // Re-check state right before the destructive action — an incoming
      // call may have started during the awaited getAudioStatus.
      if (callStore.activeCall || callStore.matrixCall) return;

      console.warn(
        "[audio-watchdog] App resumed but mode=IN_COMM with no active call → forceStopAudio",
      );
      await nativeCallBridge.forceStopAudio();
    } catch (e) {
      console.warn("[audio-watchdog] resume handler failed:", e);
    }
  });
}

/** Test-only: reset module-internal flags between test runs. */
export function __resetAudioWatchdogStateForTests(): void {
  listenerAttached = false;
}
