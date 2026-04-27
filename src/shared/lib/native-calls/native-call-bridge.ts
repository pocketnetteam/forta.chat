import { registerPlugin } from '@capacitor/core';
import { isNative } from '@/shared/lib/platform';
import { NativeWebRTC } from '@/shared/lib/native-webrtc/native-webrtc-bridge';

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

interface NativeCallNativePlugin {
  reportIncomingCall(options: {
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
  addListener(event: 'callAnswered', cb: (data: { callId: string; roomId?: string }) => void): Promise<{ remove: () => void }>;
  addListener(event: 'callDeclined', cb: (data: { callId: string }) => void): Promise<{ remove: () => void }>;
  addListener(event: 'callEnded', cb: (data: { callId: string }) => void): Promise<{ remove: () => void }>;
  addListener(event: 'audioDevicesChanged', cb: (data: {
    active: string;
    devices: Array<{ type: string; name: string }>;
  }) => void): Promise<{ remove: () => void }>;
}

const NativeCall = registerPlugin<NativeCallNativePlugin>('NativeCall');

/**
 * What the user tapped "Answer" on natively — via push ringer
 * (`getPendingAnswer`) or live `callAnswered` event. Consumed by
 * call-service.handleIncomingCall to suppress the duplicate-ring.
 *
 * Two markers because the push-side `call_id` is often just the push
 * event_id on this homeserver, which does NOT match the Matrix SDK's
 * `call.callId`. We fall through to `roomId` for reliable correlation:
 * if the user tapped Answer on ANY incoming ringer for room R, then
 * the first MatrixCall we receive for room R is the one they accepted.
 */
let pendingAnswerCallId: string | null = null;
let pendingAnswerRoomId: string | null = null;

/**
 * Decide whether the given Matrix call is the one the user already
 * accepted via the native ringer, and consume the marker on match.
 *
 * Match order:
 *   1. exact callId equality (works when the push carries the real
 *      Matrix content.call_id)
 *   2. roomId equality (fallback — our homeserver's push payloads
 *      don't include the Matrix call_id, but they do include room_id)
 *
 * Falls back to querying native directly when the in-memory markers
 * aren't set yet: on cold-start-from-push the Matrix SDK frequently
 * fires Call.incoming BEFORE `nativeCallBridge.wire()` has had a chance
 * to run `NativeCall.getPendingAnswer()` and seed the module state.
 *
 * Calling `NativeCall.getPendingAnswer` clears native state on read,
 * so this function "steals" the pending answer from the wire() path.
 * That's intentional — wire()'s waitForMatrixCall will see answerCall()
 * already in-flight (via its status guard) and no-op.
 */
export async function consumePendingAnswerCallId(
  callId: string,
  roomId?: string,
): Promise<boolean> {
  const matchAndClear = (mCall: string | null, mRoom: string | null): boolean => {
    if (mCall && mCall === callId) {
      pendingAnswerCallId = null;
      pendingAnswerRoomId = null;
      return true;
    }
    if (mRoom && roomId && mRoom === roomId) {
      pendingAnswerCallId = null;
      pendingAnswerRoomId = null;
      return true;
    }
    return false;
  };

  if (matchAndClear(pendingAnswerCallId, pendingAnswerRoomId)) return true;
  if (!isNative) return false;
  try {
    const { callId: nativeCall, roomId: nativeRoom } = await NativeCall.getPendingAnswer();
    if (matchAndClear(nativeCall ?? null, nativeRoom ?? null)) return true;
  } catch (e) {
    console.warn('[NativeCallBridge] consumePendingAnswerCallId peek failed:', e);
  }
  return false;
}

/**
 * Symmetric to pendingAnswerCallId/RoomId but for the Decline path.
 * Populated from CallConnection.onReject in Kotlin when the user taps
 * Decline in the native ringer, consumed by handleIncomingCall so the
 * matrixCall can be rejected back to Matrix (the caller otherwise keeps
 * ringing until their lifetime timeout).
 */
let pendingRejectCallId: string | null = null;
let pendingRejectRoomId: string | null = null;

export async function consumePendingRejectCallId(
  callId: string,
  roomId?: string,
): Promise<boolean> {
  const matchAndClear = (mCall: string | null, mRoom: string | null): boolean => {
    if (mCall && mCall === callId) {
      pendingRejectCallId = null;
      pendingRejectRoomId = null;
      return true;
    }
    if (mRoom && roomId && mRoom === roomId) {
      pendingRejectCallId = null;
      pendingRejectRoomId = null;
      return true;
    }
    return false;
  };

  if (matchAndClear(pendingRejectCallId, pendingRejectRoomId)) return true;
  if (!isNative) return false;
  try {
    const { callId: nativeCall, roomId: nativeRoom } = await NativeCall.getPendingReject();
    if (matchAndClear(nativeCall ?? null, nativeRoom ?? null)) return true;
  } catch (e) {
    console.warn('[NativeCallBridge] consumePendingRejectCallId peek failed:', e);
  }
  return false;
}

class NativeCallBridge {
  private callService: any = null;

  async wire(callService: { answerCall: () => void; rejectCall: () => void; hangup: () => void }): Promise<void> {
    if (!isNative) return;
    this.callService = callService;

    // Request audio permission early so WebRTC can access microphone
    try {
      await NativeCall.requestAudioPermission();
    } catch (e) {
      console.warn('[NativeCallBridge] requestAudioPermission failed:', e);
    }

    await NativeCall.addListener('callAnswered', ({ callId, roomId }) => {
      console.log('[NativeCallBridge] Call answered:', callId, 'room:', roomId);
      // Record the accept so handleIncomingCall on the JS side knows
      // to skip the duplicate-ring path and go straight to answered.
      // BOTH callId and roomId are needed because on this homeserver
      // the push payload's call_id is actually the event_id — it will
      // NEVER match the Matrix SDK's call.callId. The roomId fallback
      // is how we correlate the pending accept with the MatrixCall.
      pendingAnswerCallId = callId;
      if (roomId) pendingAnswerRoomId = roomId;
      this.waitForMatrixCallAndAnswer(callId, roomId);
    });

    await NativeCall.addListener('callDeclined', ({ callId }) => {
      console.log('[NativeCallBridge] Call declined:', callId);
      this.callService?.rejectCall();
    });

    await NativeCall.addListener('callEnded', ({ callId }) => {
      console.log('[NativeCallBridge] Call ended natively:', callId);
      this.callService?.hangup();
    });

    // Replay queued answer if user tapped Answer before JS was ready.
    //
    // Cold-start-from-push flow:
    //   1. Push wakes the OS, shows IncomingCallActivity via FCM service.
    //   2. User taps Answer while the JS app is still not running.
    //   3. Android spawns our process → Matrix client begins init + /sync.
    //   4. This wire() call runs and asks native for the queued callId.
    //
    // `callService.answerCall()` reads `callStore.matrixCall`. But the
    // Matrix SDK has only just started syncing — the m.call.invite for
    // this callId probably hasn't been parsed yet, so matrixCall is null
    // and answerCall() silently returns. Result: caller sees "connecting…"
    // forever, we hand up to chat list.
    //
    // Wait up to 30s for the SDK to deliver the invite; as soon as
    // matrixCall.callId matches the queued id, fire answerCall(). If
    // it never matches we just bail out — the auto-reject-after-30s
    // logic on the other side will take care of the caller's UI.
    try {
      const { callId: pendingCallId, roomId: pendingRoomId } = await NativeCall.getPendingAnswer();
      if (pendingCallId) {
        console.log('[NativeCallBridge] Pending answer queued, waiting for matrixCall:', pendingCallId, 'room:', pendingRoomId);
        pendingAnswerCallId = pendingCallId;
        if (pendingRoomId) pendingAnswerRoomId = pendingRoomId;
        this.waitForMatrixCallAndAnswer(pendingCallId, pendingRoomId ?? undefined);
      }
    } catch (e) {
      console.warn('[NativeCallBridge] getPendingAnswer failed:', e);
    }

    // Same pattern for Decline path. If the user tapped Decline in the
    // native ringer before the JS app was running, the rejection never
    // got sent to Matrix. Seed the module-level reject markers from
    // native so handleIncomingCall (which runs as soon as Matrix
    // delivers the invite via /sync) can call matrixCall.reject() and
    // the caller stops ringing.
    try {
      const { callId: rejectCallId, roomId: rejectRoomId } = await NativeCall.getPendingReject();
      if (rejectCallId || rejectRoomId) {
        console.log('[NativeCallBridge] Pending reject queued:', rejectCallId, 'room:', rejectRoomId);
        pendingRejectCallId = rejectCallId;
        pendingRejectRoomId = rejectRoomId;
      }
    } catch (e) {
      console.warn('[NativeCallBridge] getPendingReject failed:', e);
    }

    // Native CallActivity hangup button → proper SDK hangup
    await NativeWebRTC.addListener('onNativeHangup', () => {
      console.log('[NativeCallBridge] Native UI hangup');
      this.callService?.hangup();
    });

    // Native CallActivity video toggle → SDK renegotiation
    await NativeWebRTC.addListener('onNativeVideoToggle', ({ enabled }) => {
      console.log('[NativeCallBridge] Native video toggle:', enabled);
      this.callService?.setLocalVideoMuted(!enabled);
    });
  }

  /**
   * Poll callStore.matrixCall until it matches the given callId, then
   * fire answerCall(). Used for the cold-start-from-push flow where the
   * native side has a queued answer but Matrix SDK hasn't delivered the
   * invite event yet.
   *
   * Uses dynamic import for the store so we don't pull the Pinia graph
   * into the native-call-bridge module boundary. Times out at 30s — the
   * Matrix side will auto-reject if we never answer.
   *
   * Besides polling, each tick also actively scans the Matrix SDK's
   * rooms for the pending m.call.invite: the SDK's CallEventHandler is
   * only started after initial-sync completes, so events that arrive in
   * the very first /sync batch (the one that triggers Prepared state)
   * land in the room timeline but never reach the handler's buffer —
   * Call.incoming is silently skipped. On cold-start-from-push this
   * loses 100% of the time because the invite IS in the first sync
   * batch. The recovery pass below feeds the missed event straight
   * into the handler so it re-emits Call.incoming and our normal
   * onIncomingCall → handleIncomingCall path kicks in.
   */
  private waitForMatrixCallAndAnswer(callId: string, roomId?: string): void {
    const MAX_WAIT_MS = 30_000;
    const POLL_MS = 300;
    // Don't even attempt the invite-recovery scan for the first
    // RECOVERY_GRACE_MS — in the common case the SDK already has the
    // call mid-processing when we start polling. Feeding the same
    // invite again while SDK is still inside chooseOpponent/
    // initWithInvite makes the SDK log "already has a call - clobbering"
    // and it tears the MatrixCall down before ICE can connect. We only
    // need recovery when Matrix truly missed the event (race with the
    // initial-sync state in CallEventHandler.start), which manifests
    // as matrixCall staying null past the grace window.
    const RECOVERY_GRACE_MS = 2000;
    const deadline = Date.now() + MAX_WAIT_MS;
    const startTime = Date.now();
    let recoveryAttempted = false;

    const tick = async (): Promise<void> => {
      try {
        const { useCallStore } = await import('@/entities/call');
        const store = useCallStore();
        const current = store.matrixCall as
          | { callId?: string; roomId?: string }
          | null;
        // Match by callId (tight) OR by roomId (fallback). On our
        // homeserver the push-side id doesn't equal Matrix's call.callId
        // (it's an event_id), so roomId is the reliable correlator.
        const matchById = !!current?.callId && current.callId === callId;
        const matchByRoom =
          !!roomId && !!current?.roomId && current.roomId === roomId;
        if (current && (matchById || matchByRoom)) {
          console.log(
            '[NativeCallBridge] matrixCall ready, answering (matchById=' +
              matchById + ', matchByRoom=' + matchByRoom + '):',
            current.callId,
          );
          this.callService?.answerCall();
          return;
        }

        // Recovery pass — only after the grace window, and only if
        // the SDK really doesn't have this call yet. We double-check
        // via the SDK's own registry because the store can be a tick
        // behind handleIncomingCall.
        if (!recoveryAttempted && (Date.now() - startTime) >= RECOVERY_GRACE_MS) {
          const sdkAlreadyHasCall = await this.sdkHasCall(callId);
          if (!sdkAlreadyHasCall) {
            const recovered = await this.feedMissedInviteToSDK(callId);
            if (recovered) {
              recoveryAttempted = true;
              console.log('[NativeCallBridge] Fed missed invite back to SDK:', callId);
            }
          } else {
            // SDK is handling the call, just waiting for store to update.
            recoveryAttempted = true;
          }
        }
      } catch (e) {
        console.warn('[NativeCallBridge] waitForMatrixCall tick failed:', e);
      }
      if (Date.now() >= deadline) {
        console.warn('[NativeCallBridge] Timed out waiting for matrixCall:', callId);
        return;
      }
      setTimeout(tick, POLL_MS);
    };

    setTimeout(tick, POLL_MS);
  }

  /**
   * Walk every room's timeline looking for the m.call.invite with the
   * given call_id. If found, push it into the SDK's CallEventHandler
   * buffer and manually trigger its sync processor so Call.incoming
   * fires. Returns true when an invite was located (regardless of
   * whether the SDK ultimately accepts it — answer/hangup may have
   * been buffered alongside it and the handler will filter it out).
   *
   * Uses the SDK's internal `callEventHandler` property. It's not
   * exported from the public type, but the Bastyon fork exposes it on
   * the client instance, same as upstream.
   */
  /**
   * Probe Matrix SDK for an existing MatrixCall with the given callId.
   * Prevents the recovery path from clobbering an in-flight call:
   * when the SDK is mid-processing (chooseOpponent → initWithInvite),
   * the store hasn't been updated yet but the call DOES exist inside
   * the SDK's internal `calls` map.
   */
  private async sdkHasCall(callId: string): Promise<boolean> {
    try {
      const { getMatrixClientService } = await import('@/entities/matrix');
      const client = getMatrixClientService().client as
        | { callEventHandler?: { calls?: Map<string, unknown> } }
        | undefined;
      const calls = client?.callEventHandler?.calls;
      if (calls && typeof calls.has === 'function') {
        return calls.has(callId);
      }
    } catch {
      // ignore
    }
    return false;
  }

  private async feedMissedInviteToSDK(callId: string): Promise<boolean> {
    try {
      const { getMatrixClientService } = await import('@/entities/matrix');
      const client = getMatrixClientService().client as
        | { callEventHandler?: { onRoomTimeline: (e: unknown) => void; onSync: () => void }; getRooms?: () => Array<{ getLiveTimeline?: () => { getEvents?: () => Array<{ getType: () => string; getContent: () => Record<string, unknown> }> } }> }
        | undefined;
      if (!client?.callEventHandler || !client.getRooms) return false;

      for (const room of client.getRooms()) {
        const events = room.getLiveTimeline?.()?.getEvents?.() ?? [];
        for (const event of events) {
          const type = event.getType();
          if (type !== 'm.call.invite' && !type.startsWith('org.matrix.call.')) continue;
          const content = event.getContent();
          if ((content as { call_id?: string }).call_id !== callId) continue;
          // Push into the handler's buffer and force it to process.
          client.callEventHandler.onRoomTimeline(event);
          client.callEventHandler.onSync();
          return true;
        }
      }
      return false;
    } catch (e) {
      console.warn('[NativeCallBridge] feedMissedInviteToSDK failed:', e);
      return false;
    }
  }

  async reportIncomingCall(options: {
    callId: string;
    callerName: string;
    roomId: string;
    hasVideo: boolean;
  }): Promise<void> {
    if (!isNative) return;
    await NativeCall.reportIncomingCall(options);
  }

  async reportOutgoingCall(options: {
    callId: string;
    callerName: string;
    hasVideo: boolean;
  }): Promise<void> {
    if (!isNative) return;
    try {
      await NativeCall.reportOutgoingCall(options);
    } catch (e) {
      console.warn('[NativeCallBridge] reportOutgoingCall failed:', e);
    }
  }

  async reportCallConnected(callId: string): Promise<void> {
    if (!isNative) return;
    try {
      await NativeCall.reportCallConnected({ callId });
    } catch (e) {
      console.warn('[NativeCallBridge] reportCallConnected failed:', e);
    }
  }

  async reportCallEnded(callId: string): Promise<void> {
    if (!isNative) return;
    await NativeCall.reportCallEnded({ callId });
  }

  async requestAudioPermission(): Promise<{ granted: boolean }> {
    if (!isNative) return { granted: true };
    return NativeCall.requestAudioPermission();
  }

  async requestCameraPermission(): Promise<{ granted: boolean }> {
    if (!isNative) return { granted: true };
    return NativeCall.requestCameraPermission();
  }

  /**
   * Confirm the microphone is actually usable *right now*. Unlike
   * `requestAudioPermission`, this bypasses the per-app permission cache
   * and probes the real AudioRecord/AudioManager state:
   *
   *   - Enumerates input devices (catches "no mic attached" on tablets /
   *     some Chromebooks / rare Android TV boxes).
   *   - Attempts `AudioRecord(VOICE_COMMUNICATION, 16kHz, mono, PCM_16)`
   *     and checks `state == STATE_INITIALIZED` (catches Xiaomi/Huawei
   *     OEM ghost permissions, MIUI privacy shield, mic-held-by-other-app).
   *   - Returns currently-active recording sources on Android 10+ for the
   *     UI to show "X is using your microphone".
   *
   * Safe fallbacks:
   *   - Non-native (web, Electron): always reports available.
   *   - Older native builds without this method: treated as available too —
   *     we are strictly additive and must not regress web users whose
   *     plugin is pre-Session-01.
   */
  async probeAudioAvailability(): Promise<AudioProbeResult> {
    if (!isNative) {
      return { available: true, hasInput: true, canInit: true, conflicting: [] };
    }
    try {
      const res = await NativeCall.probeAudioAvailability();
      return {
        available: !!res?.available,
        hasInput: !!res?.hasInput,
        canInit: !!res?.canInit,
        conflicting: Array.isArray(res?.conflicting) ? res.conflicting : [],
      };
    } catch (e) {
      // The method may be missing on older APKs — Capacitor rejects with
      // "No method registered". Treat as optimistic: don't block call setup
      // just because the probe itself failed, otherwise an app update would
      // break calls for users whose older-build native plugin refuses to
      // answer. The subsequent SDK getUserMedia path still fails-fast if
      // AudioRecord genuinely cannot init thanks to the AudioInitException
      // plumbing in NativeWebRTCManager.
      console.warn('[NativeCallBridge] probeAudioAvailability unavailable:', e);
      return { available: true, hasInput: true, canInit: true, conflicting: [] };
    }
  }

  /**
   * Activate VoIP audio routing via native AudioRouter.
   *
   * Must be called immediately after the call is placed/answered.
   * Wires MODE_IN_COMMUNICATION, setCommunicationDevice (API 31+),
   * AudioDeviceCallback for BT hot-swap, and OEM delayed re-apply
   * (Xiaomi/Realme/XOS reset audio mode ~500 ms after init).
   */
  async startAudioRouting(options: { callType: string }): Promise<void> {
    if (!isNative) return;
    try {
      await NativeCall.startAudioRouting(options);
    } catch (e) {
      console.warn('[NativeCallBridge] startAudioRouting failed:', e);
    }
  }

  /**
   * Tear down VoIP audio routing.
   *
   * Must be called on hangup / reject / ended. Restores MODE_NORMAL,
   * clears communication device, unregisters receivers.
   */
  async stopAudioRouting(): Promise<void> {
    if (!isNative) return;
    try {
      await NativeCall.stopAudioRouting();
    } catch (e) {
      console.warn('[NativeCallBridge] stopAudioRouting failed:', e);
    }
  }

  /**
   * Brute-force reset of audio state. Bypasses the lifecycle guards in
   * AudioRouter — used by the app-resume watchdog to recover from a
   * crashed call where the normal cleanup path never ran (JS process
   * killed mid-call, OEM stopped the foreground service, etc.).
   *
   * Symmetric to {@link stopAudioRouting} but unconditional: always
   * resets mode → NORMAL and clears the communication device.
   */
  async forceStopAudio(): Promise<void> {
    if (!isNative) return;
    try {
      await NativeCall.forceStopAudio();
    } catch (e) {
      console.warn('[NativeCallBridge] forceStopAudio failed:', e);
    }
  }

  /**
   * Read current AudioManager mode and routing flags from native.
   * Returns mode = "MODE_NORMAL" when no call active or
   * "MODE_IN_COMMUNICATION" while a VoIP call is in progress.
   *
   * On non-native or older native builds without this method we report
   * an optimistic NORMAL — the watchdog treats anything other than
   * MODE_IN_COMMUNICATION as healthy, so an unavailable probe is safe.
   */
  async getAudioStatus(): Promise<{
    mode: string;
    isSpeakerOn: boolean;
    isBtScoOn: boolean;
  }> {
    if (!isNative) {
      return { mode: 'MODE_NORMAL', isSpeakerOn: false, isBtScoOn: false };
    }
    try {
      return await NativeCall.getAudioStatus();
    } catch (e) {
      console.warn('[NativeCallBridge] getAudioStatus unavailable:', e);
      return { mode: 'MODE_NORMAL', isSpeakerOn: false, isBtScoOn: false };
    }
  }
}

export const nativeCallBridge = new NativeCallBridge();
