import { App as CapApp } from "@capacitor/app";
import { isIOS, isNative } from "@/shared/lib/platform";
import { nativeCallBridge } from "@/shared/lib/native-calls";
import { IOSCallAudio } from "@/shared/lib/native-calls/native-call-bridge.ios";
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
 *
 * iOS additionally subscribes to AVAudioSession interruption events
 * (audioInterruptionBegan) so that a real cellular phone call coming in
 * mid-VoIP-call gracefully ends our call instead of leaving the user
 * with two competing call surfaces and our audio session permanently
 * paused. Surfaced by the Swift IOSCallAudio plugin (Step 6 Task 6).
 */

let listenerAttached = false;
let interruptionListenerAttached = false;

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

  // iOS-specific: AVAudioSession interruption recovery.
  //
  // When iOS hands the audio session to a real cellular phone call (or
  // Siri, or a system alarm), AVAudioSession posts .interruptionNotification
  // with type=.began. CallKit pauses our call's audio path
  // automatically, but our JS-side call state stays "connected" — the
  // user sees a UI that pretends the call is still live while no audio
  // flows. Worse: when the interruption ends, we cannot reliably
  // re-acquire the audio session because the user-driven CallKit hangup
  // (when they end the cellular call) has already moved us into a
  // post-call state that the JS layer never observed.
  //
  // Cleanest UX: end our call as soon as the interruption begins. This
  // matches Element iOS's behavior and what users expect when the
  // ringing-real-phone-call cuts off the VoIP session. Mirrors the
  // Android stuck-mode watchdog in spirit (recover state when the OS
  // takes audio out from under us) but is event-driven rather than
  // poll-based since iOS gives us a real notification.
  if (isIOS && !interruptionListenerAttached) {
    interruptionListenerAttached = true;
    try {
      await IOSCallAudio.addListener("audioInterruptionBegan", () => {
        try {
          const callStore = useCallStore();
          if (!callStore.activeCall && !callStore.matrixCall) return;
          console.warn(
            "[audio-watchdog] AVAudioSession interruption began → hanging up active call",
          );
          // Use the call-service's hangup path via the bridge so the
          // teardown ordering (stopAudioRouting → reportCallEnded →
          // peer disconnect) matches the user-driven hangup case. We
          // dynamic-import call-service to keep the audio-watchdog
          // free of the heavy WebRTC graph at load time.
          void import("@/features/video-calls/model/call-service").then(
            ({ callService }) => callService.hangup(),
          ).catch((e) => {
            console.warn("[audio-watchdog] call-service import failed:", e);
          });
        } catch (e) {
          console.warn("[audio-watchdog] interruption handler failed:", e);
        }
      });
    } catch (e) {
      // IOSCallAudio may not be registered (e.g. plugin not yet built
      // in a dev session); that's a v1 deployment issue, not a runtime
      // crash. Log and continue — the rest of the watchdog (resume
      // handler) is unaffected.
      console.warn("[audio-watchdog] failed to subscribe to AVAudioSession interruption:", e);
      interruptionListenerAttached = false;
    }
  }
}

/** Test-only: reset module-internal flags between test runs. */
export function __resetAudioWatchdogStateForTests(): void {
  listenerAttached = false;
  interruptionListenerAttached = false;
}
