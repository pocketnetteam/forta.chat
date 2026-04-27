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
      if (callStore.activeCall) return;

      const status = await nativeCallBridge.getAudioStatus();
      if (status.mode !== "MODE_IN_COMMUNICATION") return;

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
