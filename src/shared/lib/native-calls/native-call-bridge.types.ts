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
  /** RemoteMessage.priority as delivered: 1 high, 2 normal, 0 unknown. Absent in older builds. */
  priority?: number;
  /** RemoteMessage.originalPriority as sent; differs when FCM downgraded the push. */
  originalPriority?: number;
  /** "fcm", or "missing" when the push carried no send time (the latency means nothing then). */
  sentTimeSource?: string;
  /** What became of the push: rang, stale, signed-out, incoming-calls-off, established, second-ring. */
  outcome?: string;
}

/**
 * One audio-stack event recorded during a call, as produced by
 * CallAudioTimeline.kt. `atMs` is relative to the first entry, so a report
 * reads as an elapsed-time sequence rather than wall clock.
 */
export interface AudioTimelineEntry {
  atMs: number;
  event: string;
  detail: string;
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
  getPendingAnswer(): Promise<{
    callId: string | null;
    roomId: string | null;
    /**
     * Wall-clock ms when native wrote the marker, 0 when there is none.
     * Absent on iOS, whose adapter reads live CallKit state instead of a
     * stored marker. See `matchesPendingCallMarker`.
     */
    atMs?: number | null;
  }>;
  /**
   * Check if user tapped Decline before JS was ready. Symmetric to
   * getPendingAnswer — JS consumer calls matrixCall.reject() when the
   * SDK later delivers the invite so the caller stops ringing.
   */
  getPendingReject(): Promise<{
    callId: string | null;
    roomId: string | null;
    /** See `getPendingAnswer`. */
    atMs?: number | null;
  }>;
  /**
   * Retire both markers for a call JS has finished with, so neither can
   * reach the next invite from that room. Matched on callId OR roomId — a
   * connection created from a push is keyed by an event_id that never equals
   * the Matrix callId, so the room is the only key both paths share.
   */
  retirePendingMarkers(options: {
    callId: string;
    /**
     * Omitted when another call JS knows about is still live in that room, so
     * native never widens a retire past what JS can vouch for.
     */
    roomId?: string;
  }): Promise<void>;
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
  /** `callId` names the call that owns the routing (C02); a stop for another call is dropped. */
  startAudioRouting(options: { callType: string; callId?: string }): Promise<void>;
  stopAudioRouting(options?: { callId?: string }): Promise<void>;
  /**
   * Brute-force reset of audio state without going through the
   * lifecycle guards. Used by the app-resume watchdog when the device
   * is stuck in MODE_IN_COMMUNICATION but no call is live.
   */
  forceStopAudio(): Promise<void>;
  /**
   * Release a self-managed Telecom connection left ringing past its
   * deadline. Android only — see
   * {@link NativeCallBridge.releaseStaleRingingCall}.
   */
  releaseStaleRingingCall(): Promise<{ released: boolean }>;
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
   * Ordered audio-stack events for the current call — see
   * {@link NativeCallBridge.getAudioTimeline}.
   */
  getAudioTimeline(): Promise<{ entries: AudioTimelineEntry[] }>;
  /**
   * Session 25 / S3-S4: snapshot of the last N FCM `m.call.invite`
   * records. Surfaced by {@link NativeCallBridge.getInviteThrottleSnapshot}.
   */
  getInviteThrottleSnapshot(): Promise<InviteThrottleSnapshot>;
  addListener(
    event: 'callAnswered',
    cb: (data: { callId: string; roomId?: string }) => void,
  ): Promise<PluginListenerHandle>;
  /**
   * `roomId` for the same reason `callAnswered` carries one: a connection
   * created from a push is keyed by the push payload's `call_id`, which this
   * homeserver fills with the event_id, so its `callId` can never equal the
   * SDK's. The room is then the only way to tell an event about the call on
   * screen from one about a call that already ended.
   */
  addListener(
    event: 'callDeclined',
    cb: (data: { callId: string; roomId?: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'callEnded',
    cb: (data: { callId: string; roomId?: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'audioDevicesChanged',
    cb: (data: {
      active: string;
      devices: Array<{ type: string; name: string }>;
    }) => void,
  ): Promise<PluginListenerHandle>;
}
