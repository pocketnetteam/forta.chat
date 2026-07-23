import type { PluginListenerHandle } from '@capacitor/core';

/**
 * Shape returned by `NativeCall.probeAudioAvailability`. See
 * {@link NativeCallBridge.probeAudioAvailability} for semantics.
 */
export interface AudioProbeResult {
  available: boolean;
  hasInput: boolean;
  canInit: boolean;
  /**
   * Hint of what may be holding the mic. Populated on Android 10+ from
   * AudioManager.getActiveRecordingConfigurations. Empty array when no
   * conflicting use is detected, or the platform cannot enumerate it.
   */
  conflicting?: string[];
}

/**
 * Single FCM `m.call.invite` record for the JS bug-reporter. See
 * `InviteThrottleTracker.kt` for the data source.
 */
export interface InviteThrottleRecord {
  /** When the FCM service handled the push (System.currentTimeMillis()). */
  receivedAtMs: number;
  /** RemoteMessage.sentTime — homeserver send time. */
  sentAtMs: number;
  /** Convenience field for envelope readers. */
  deliveryLatencyMs: number;
  /** Was the invite already past its lifetime when received? */
  expired: boolean;
  /** `call_id` from the FCM payload, "" when missing. */
  callId: string;
}

export interface InviteThrottleSnapshot {
  records: InviteThrottleRecord[];
}

/**
 * Capacitor plugin contract for the Android-side `NativeCall.kt`. The iOS
 * adapter (`native-call-bridge.ios.ts`) implements the SAME shape but
 * routes to `@capgo/capacitor-incoming-call-kit` + `IOSCallAudio` so the
 * bridge in `native-call-bridge.ts` does not need per-platform branching
 * inside every method.
 */
export interface NativeCallNativePlugin {
  reportIncomingCall(options: {
    callId: string;
    callerName: string;
    roomId: string;
    hasVideo: boolean;
  }): Promise<void>;
  /**
   * WEE-31: idempotent ringer-surface ensurer. Launches the native
   * IncomingCallActivity ONLY IF neither the activity nor the Telecom
   * CallConnection is already showing. Use this from `handleIncomingCall`
   * on the isNative path so that, when Matrix /sync delivers the invite
   * before FCM does (typical when the app is in the foreground), the user
   * still sees a ringer instead of nothing.
   */
  ensureIncomingCallVisible(options: {
    callId: string;
    callerName: string;
    roomId: string;
    hasVideo: boolean;
  }): Promise<void>;
  /**
   * Check if user tapped Answer before JS was ready.
   * Returns the push-side call_id AND the room_id, because the push
   * payload's call_id is often the event_id (not Matrix's content.
   * call_id), so room is the reliable correlation key.
   */
  getPendingAnswer(): Promise<{ callId: string | null; roomId: string | null }>;
  /**
   * Check if user tapped Decline before JS was ready. Symmetric to
   * getPendingAnswer — JS consumer calls matrixCall.reject() when the
   * SDK later delivers the invite so the caller stops ringing.
   */
  getPendingReject(): Promise<{ callId: string | null; roomId: string | null }>;
  reportOutgoingCall(options: {
    callId: string;
    callerName: string;
    hasVideo: boolean;
  }): Promise<void>;
  reportCallConnected(options: { callId: string }): Promise<void>;
  reportCallEnded(options: { callId: string }): Promise<void>;
  requestAudioPermission(): Promise<{ granted: boolean }>;
  requestCameraPermission(): Promise<{ granted: boolean }>;
  /**
   * Real-stream probe. Runs AudioRecord init + input-device enumeration to
   * confirm the microphone can actually be opened right now. See
   * `CallPlugin.probeAudioAvailability` in Kotlin for the rationale.
   *
   * Older builds of the native plugin don't ship this method; callers must
   * go through {@link NativeCallBridge.probeAudioAvailability} which has a
   * safe-by-default fallback for that case.
   */
  probeAudioAvailability(): Promise<AudioProbeResult>;
  getAudioDevices(): Promise<{
    active: string;
    devices: Array<{ type: string; name: string }>;
  }>;
  setAudioDevice(options: { type: string }): Promise<void>;
  startAudioRouting(options: { callType: string }): Promise<void>;
  stopAudioRouting(): Promise<void>;
  /**
   * Brute-force reset of audio state without going through the
   * lifecycle guards. Used by the app-resume watchdog when the device
   * is stuck in MODE_IN_COMMUNICATION but no call is live.
   */
  forceStopAudio(): Promise<void>;
  /**
   * Snapshot of the current AudioManager state. Used by the app-resume
   * watchdog to detect a stuck VoIP audio mode.
   */
  getAudioStatus(): Promise<{
    mode: string;
    isSpeakerOn: boolean;
    isBtScoOn: boolean;
  }>;
  /**
   * Session 25 / S3-S4: snapshot of the last N FCM `m.call.invite`
   * records. Surfaced by {@link NativeCallBridge.getInviteThrottleSnapshot}.
   */
  getInviteThrottleSnapshot(): Promise<InviteThrottleSnapshot>;
  addListener(
    event: 'callAnswered',
    cb: (data: { callId: string; roomId?: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'callDeclined',
    cb: (data: { callId: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'callEnded',
    cb: (data: { callId: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'audioDevicesChanged',
    cb: (data: {
      active: string;
      devices: Array<{ type: string; name: string }>;
    }) => void,
  ): Promise<PluginListenerHandle>;
}
