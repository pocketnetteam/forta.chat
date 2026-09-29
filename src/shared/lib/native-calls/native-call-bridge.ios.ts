import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { Camera } from '@capacitor/camera';
import type {
  AudioProbeResult,
  InviteThrottleSnapshot,
  NativeCallNativePlugin,
} from './native-call-bridge.types';

/**
 * iOS adapter for the `nativeCallBridge` surface defined in
 * `native-call-bridge.ts`. Wires the same Android-shaped interface to:
 *
 *   * `@capgo/capacitor-incoming-call-kit` — CallKit ringer (incoming UI).
 *   * Custom `IOSCallAudio` plugin (Step 6 Task 4) — AVAudioSession.
 *   * Custom `IOSVoIPPush` plugin (Step 6 Task 3) — separately wired in
 *     `src/shared/lib/push/push-service.ts`, not used here.
 *
 * Why an adapter instead of branching every method inside the bridge:
 * the bridge's internal logic (pending-answer cache, waitForMatrixCall
 * recovery loop, finalize-call ordering) is platform-agnostic and we
 * want zero touch on it. The bridge picks one of two adapters at module
 * load (`isIOS ? iosAdapter : NativeCall`) and the rest of the file is
 * completely unchanged.
 *
 * ## Plugin API mismatch vs Step 6 plan
 *
 * The plan's "JS bridge → Plugin equivalent" table assumes the plugin
 * exposes `markConnected` / `getPendingAnswer` / `getPendingReject`. The
 * actual `@capgo/capacitor-incoming-call-kit` v8.2.x does NOT — see
 * https://www.npmjs.com/package/@capgo/capacitor-incoming-call-kit for the
 * canonical surface. Mapping we use instead:
 *
 *   - `markConnected({callId})` → no-op. CallKit handles incoming-call
 *     "connected" state internally once the user taps Accept; there is
 *     no public API to mark it from JS in this plugin.
 *   - `getPendingAnswer()` → poll `IncomingCallKit.getActiveCalls()` for
 *     a record with `state === 'accepted'`. The plugin natively buffers
 *     `callAccepted` events as well, so the cold-start accept ALSO reaches
 *     the listener once it's attached. Both paths populate the same
 *     `pendingAnswerCallId` slot in the bridge — the bridge already has
 *     a "first writer wins / consumer clears" model for this.
 *   - `getPendingReject()` → analogous, looking for `state === 'ended'`
 *     records that came from a user-decline before the bridge was alive.
 *     CallKit doesn't really distinguish "declined cold-start" from
 *     "ended cold-start" beyond the source field, so we match
 *     `source === 'user'` to be safe.
 *   - Event payloads: plugin emits `{call: IncomingCallRecord, source}`,
 *     not `{callId}`. We unwrap to `{callId, roomId}` from `extra.roomId`.
 *
 * ## Outgoing-call CallKit reporting
 *
 * `reportOutgoingCall` is a no-op on iOS in v1. The plugin does not
 * expose `CXProvider.reportNewCallWithStartedConnectingAt(...)` or the
 * matching Connected variant, so outgoing calls placed from inside the
 * app do not show up in iOS Recents. Acceptable trade-off — the in-app
 * call UI is identical to Android, and PushKit incoming calls (Task 3)
 * still ring via CallKit. See comment near `reportOutgoingCall` below.
 */

interface IncomingCallRecord {
  callId: string;
  callerName: string;
  handle: string;
  hasVideo: boolean;
  state: 'ringing' | 'accepted' | 'ended';
  platform: 'android' | 'ios' | 'web';
  extra?: Record<string, unknown>;
}

interface IncomingCallEvent {
  call: IncomingCallRecord;
  reason?: string;
  source?: 'api' | 'user' | 'system';
}

interface ShowIncomingCallOptions {
  callId: string;
  callerName: string;
  handle: string;
  hasVideo: boolean;
  appName?: string;
  timeoutMs?: number;
  extra?: Record<string, unknown>;
  ios?: {
    handleType?: 'generic' | 'phoneNumber' | 'emailAddress';
    supportsHolding?: boolean;
    supportsDTMF?: boolean;
    supportsGrouping?: boolean;
    supportsUngrouping?: boolean;
  };
}

interface IncomingCallKitPlugin {
  showIncomingCall(opts: ShowIncomingCallOptions): Promise<{ call: IncomingCallRecord }>;
  endCall(opts: { callId: string; reason?: string }): Promise<{ calls: IncomingCallRecord[] }>;
  endAllCalls(opts?: { reason?: string }): Promise<{ calls: IncomingCallRecord[] }>;
  getActiveCalls(): Promise<{ calls: IncomingCallRecord[] }>;
  requestPermissions(): Promise<{ notifications: string; fullScreenIntent: string }>;
  addListener(
    event: 'callAccepted' | 'callDeclined' | 'callEnded' | 'callTimedOut' | 'incomingCallDisplayed',
    cb: (e: IncomingCallEvent) => void,
  ): Promise<PluginListenerHandle>;
}

export const IncomingCallKit = registerPlugin<IncomingCallKitPlugin>('IncomingCallKit');

/**
 * Custom Swift plugin (Step 6 Task 4). Owns AVAudioSession so background
 * mid-call audio survives + (Task 6) surfaces system interruption events
 * so the JS watchdog can end our call cleanly when iOS hands the audio
 * session to a real cellular phone call / Siri / system alarm.
 */
export interface IOSCallAudioPlugin {
  requestRecordPermission(): Promise<{ granted: boolean }>;
  probeAvailability(): Promise<AudioProbeResult>;
  start(opts: { callType: string }): Promise<void>;
  stop(): Promise<void>;
  forceStop(): Promise<void>;
  getStatus(): Promise<{
    mode: string;
    isSpeakerOn: boolean;
    isBtScoOn: boolean;
  }>;
  setOutput(opts: { device: string }): Promise<void>;
  /**
   * AVAudioSession.interruptionNotification (.began). Fires when iOS takes
   * the audio session away from us — typically a real cellular phone call,
   * Siri activation, or a system alarm.
   */
  addListener(
    event: 'audioInterruptionBegan',
    cb: () => void,
  ): Promise<PluginListenerHandle>;
  /**
   * AVAudioSession.interruptionNotification (.ended). The `shouldResume`
   * flag mirrors the AVAudioSessionInterruptionOptions.shouldResume bit.
   */
  addListener(
    event: 'audioInterruptionEnded',
    cb: (data: { shouldResume?: boolean }) => void,
  ): Promise<PluginListenerHandle>;
}

export const IOSCallAudio = registerPlugin<IOSCallAudioPlugin>('IOSCallAudio');

/**
 * Translate an IncomingCallEvent from the plugin into the
 * Android-shaped `{callId, roomId?}` payload the bridge consumes.
 */
function unwrapEvent(e: IncomingCallEvent): { callId: string; roomId?: string } {
  const callId = e.call?.callId ?? '';
  const roomIdRaw = e.call?.extra?.roomId;
  const roomId = typeof roomIdRaw === 'string' && roomIdRaw.length > 0 ? roomIdRaw : undefined;
  return { callId, roomId };
}

/**
 * Build an adapter that satisfies the Android-shaped
 * `NativeCallNativePlugin` contract by routing to IncomingCallKit +
 * IOSCallAudio. Returned object is plain (no `this`) so it can be
 * assigned to `bridge.nativePlugin` without `bind()` headaches.
 */
/**
 * When this adapter last ended a CallKit record itself (see
 * `releasedToWebKit` inside the adapter). CallKit deactivates the session it
 * activated for that call, which reaches the app as an AVAudioSession
 * interruption; the audio watchdog must not read that one as a phone call
 * taking over.
 */
let lastCallKitReleaseAt = 0;

/** True while an interruption could still be the echo of our own CallKit release. */
export function isRecentCallKitRelease(now: number = Date.now()): boolean {
  return now - lastCallKitReleaseAt < 5_000;
}

export function createIOSNativeCallAdapter(): NativeCallNativePlugin {
  // Tracks every active call so endCall() can be no-throw idempotent
  // and so we can derive a CallKit handle (CallKit needs SOMETHING
  // non-empty in the `handle` field even for our generic chat handles).
  const knownCalls = new Map<
    string,
    { roomId: string; callerName: string; hasVideo: boolean }
  >();

  /**
   * When this adapter first saw a call in a state that makes it a marker,
   * keyed by `callId` and that state.
   *
   * The marker match falls back to `roomId` when the ids cannot be compared,
   * and that fallback is bounded by the marker's age — the rule that stopped a
   * stale reject from declining a later call from the same room unheard. It
   * needs a write time, and iOS had none to give: CallKit records carry no
   * timestamp, and `matchesPendingCallMarker` reads a missing stamp as "this
   * platform cannot tell", leaving the room fallback open for ever. That is
   * not a theoretical gap here — unlike Android's, these getters are a live
   * read rather than read-and-clear, so CallKit hands the same accepted or
   * ended call back on every peek for as long as it keeps the record.
   *
   * First observation is the honest approximation available: it trails the
   * user's tap by however long the app took to reach this code, which on the
   * cold-start path these markers exist for is seconds. Keyed by state as well
   * as id because accepting a call and later ending it are two decisions, and
   * the reject marker must not inherit the accept's moment.
   */
  const markerFirstSeen = new Map<string, number>();

  /**
   * Calls whose CallKit record this adapter ended itself, right after the
   * answer, to hand the audio hardware to WebKit.
   *
   * Experiment 2026-09-24 (iPhone XR, iOS 17.3): in a CallKit-answered call
   * the peer's RTP arrives and ours is sent, but neither is heard — the
   * audio session CallKit activates for this process (PhoneCall priority)
   * starves the WebKit GPU process's own session, which does both the
   * playback and the microphone capture. An outgoing call from the open
   * app, with no CallKit record, carries audio both ways. Ending the CallKit
   * call once the WebRTC call is answered releases that session; CallKit
   * then only ever served as the ringer. The plugin reports the end with
   * `source: "api"`, and the `callEnded` mapping below drops those events
   * for the ids listed here so the release does not hang up the call.
   */
  const releasedToWebKit = new Set<string>();

  async function releaseCallKitAudio(): Promise<void> {
    try {
      const { calls } = await IncomingCallKit.getActiveCalls();
      const accepted = calls.find((c) => c.state === 'accepted');
      if (!accepted) return;
      releasedToWebKit.add(accepted.callId);
      lastCallKitReleaseAt = Date.now();
      await IncomingCallKit.endCall({ callId: accepted.callId, reason: 'audio-handoff' });
      console.log('[NativeCallBridge.iOS] CallKit call released to WebKit audio:', accepted.callId);
    } catch (e) {
      console.warn('[NativeCallBridge.iOS] releaseCallKitAudio failed:', e);
    }
  }

  /** Stamp for `callId` in `state`, minted once and stable thereafter. */
  function markerStamp(callId: string, state: string): number {
    const key = state + ':' + callId;
    const seen = markerFirstSeen.get(key);
    if (seen !== undefined) return seen;
    const now = Date.now();
    markerFirstSeen.set(key, now);
    return now;
  }

  /**
   * Drop stamps for calls CallKit no longer reports.
   *
   * Without this every call the process ever saw stays here for its lifetime,
   * and the map is the only thing that decides whether a marker looks fresh.
   */
  function forgetVanishedCalls(live: IncomingCallRecord[]): void {
    const alive = new Set(live.map((c) => c.callId));
    for (const key of [...markerFirstSeen.keys()]) {
      const callId = key.slice(key.indexOf(':') + 1);
      if (!alive.has(callId)) markerFirstSeen.delete(key);
    }
  }

  return {
    async reportIncomingCall(opts) {
      knownCalls.set(opts.callId, {
        roomId: opts.roomId,
        callerName: opts.callerName,
        hasVideo: opts.hasVideo,
      });
      try {
        await IncomingCallKit.showIncomingCall({
          callId: opts.callId,
          callerName: opts.callerName,
          // CallKit shows `handle` as a secondary identifier; pass the
          // Matrix room id so power users can distinguish multiple
          // simultaneous incoming calls. iOS's CallKit UI hides it
          // behind the caller name, so it's harmless when meaningless.
          handle: opts.roomId,
          hasVideo: opts.hasVideo,
          extra: { roomId: opts.roomId },
          ios: { handleType: 'generic' },
        });
      } catch (e) {
        console.warn('[NativeCallBridge.iOS] showIncomingCall failed:', e);
        knownCalls.delete(opts.callId);
        throw e;
      }
    },

    // WEE-31: CallKit already owns a single ringer surface; re-showing
    // via reportIncomingCall is the closest idempotent equivalent.
    async ensureIncomingCallVisible(opts) {
      await this.reportIncomingCall(opts);
    },

    async getPendingAnswer() {
      try {
        const { calls } = await IncomingCallKit.getActiveCalls();
        forgetVanishedCalls(calls);
        // First accepted (cold-start) call wins. CallKit can't have
        // more than one "accepted" call at a time on iOS without
        // CallGrouping, which we don't enable.
        const accepted = calls.find((c) => c.state === 'accepted');
        if (!accepted) return { callId: null, roomId: null };
        const roomIdRaw = accepted.extra?.roomId;
        const roomId =
          typeof roomIdRaw === 'string' && roomIdRaw.length > 0 ? roomIdRaw : null;
        const pending = {
          callId: accepted.callId,
          roomId,
          atMs: markerStamp(accepted.callId, accepted.state),
        };
        // Cold start: the accept happened before this adapter's listeners
        // existed, so this read is the first chance to release CallKit before
        // the answer (see releasedToWebKit). The bridge treats this read as
        // read-and-clear anyway and keeps its own copy of the marker.
        await releaseCallKitAudio();
        return pending;
      } catch (e) {
        console.warn('[NativeCallBridge.iOS] getPendingAnswer failed:', e);
        return { callId: null, roomId: null };
      }
    },

    async getPendingReject() {
      // CallKit "ended by user" before bridge alive. We don't have a
      // dedicated "declined" state on iOS — the plugin reports decline
      // as `callDeclined` event and then the call transitions to ended.
      // For the cold-start path we can only reliably detect ended-via-
      // user; that's enough to send Matrix the rejection.
      try {
        const { calls } = await IncomingCallKit.getActiveCalls();
        forgetVanishedCalls(calls);
        const declined = calls.find((c) => c.state === 'ended');
        if (!declined) return { callId: null, roomId: null };
        const roomIdRaw = declined.extra?.roomId;
        const roomId =
          typeof roomIdRaw === 'string' && roomIdRaw.length > 0 ? roomIdRaw : null;
        return {
          callId: declined.callId,
          roomId,
          atMs: markerStamp(declined.callId, declined.state),
        };
      } catch (e) {
        console.warn('[NativeCallBridge.iOS] getPendingReject failed:', e);
        return { callId: null, roomId: null };
      }
    },

    async retirePendingMarkers(_opts) {
      // Nothing stored to retire: iOS derives both pending states from live
      // CallKit calls rather than from markers, so they go away with the call
      // itself. Android's stored markers are what outlive it.
    },

    async reportOutgoingCall(_opts) {
      // No CallKit outgoing-call surface in @capgo/capacitor-incoming-call-kit
      // v8. Calls placed from in-app are tracked only by our Vue UI; the
      // user does not see them in the iOS system Recents. Acceptable for
      // v1; revisit if outgoing-call CallKit integration is requested.
    },

    async reportCallConnected(_opts) {
      // No `markConnected` in this plugin. CallKit's default behavior
      // for incoming calls auto-transitions to "connected" once the
      // user taps Accept. Outgoing calls aren't reported at all (see
      // reportOutgoingCall comment), so there's nothing to mark.
    },

    async reportCallEnded(opts) {
      knownCalls.delete(opts.callId);
      try {
        await IncomingCallKit.endCall({ callId: opts.callId });
      } catch (e) {
        // Endpoint already gone is a normal race. Don't surface it to
        // the bridge — finalize-call would log a noisy error otherwise.
        console.warn(
          '[NativeCallBridge.iOS] endCall failed (likely already ended):',
          e,
        );
      }
    },

    async requestAudioPermission() {
      try {
        return await IOSCallAudio.requestRecordPermission();
      } catch (e) {
        console.warn('[NativeCallBridge.iOS] requestAudioPermission failed:', e);
        return { granted: false };
      }
    },

    async requestCameraPermission() {
      try {
        const result = await Camera.requestPermissions({ permissions: ['camera'] });
        return { granted: result.camera === 'granted' };
      } catch (e) {
        console.warn('[NativeCallBridge.iOS] requestCameraPermission failed:', e);
        return { granted: false };
      }
    },

    async probeAudioAvailability() {
      try {
        return await IOSCallAudio.probeAvailability();
      } catch (e) {
        console.warn('[NativeCallBridge.iOS] probeAudioAvailability failed:', e);
        // Optimistic fallback: don't block call setup just because the
        // probe is unimplemented or the plugin is older than this build.
        // Same policy the Android bridge applies in the wrapper.
        return { available: true, hasInput: true, canInit: true, conflicting: [] };
      }
    },

    async getAudioDevices() {
      // v1: single "default" entry — iOS's audio routing is exposed via
      // the Control Center route picker, not an in-app device list.
      // Custom picker UI is explicitly out of scope per Step 6 plan.
      return { active: 'default', devices: [{ type: 'default', name: 'Default' }] };
    },

    async setAudioDevice(_opts) {
      // v1 no-op. Could route to IOSCallAudio.setOutput later when an
      // in-app picker is added.
    },

    async startAudioRouting(opts) {
      try {
        await IOSCallAudio.start(opts);
      } catch (e) {
        console.warn('[NativeCallBridge.iOS] startAudioRouting failed:', e);
      }
      await releaseCallKitAudio();
    },

    async stopAudioRouting() {
      try {
        await IOSCallAudio.stop();
      } catch (e) {
        console.warn('[NativeCallBridge.iOS] stopAudioRouting failed:', e);
      }
    },

    async forceStopAudio() {
      try {
        await IOSCallAudio.forceStop();
      } catch (e) {
        console.warn('[NativeCallBridge.iOS] forceStopAudio failed:', e);
      }
    },

    async releaseStaleRingingCall(): Promise<{ released: boolean }> {
      // Telecom self-managed connections are an Android concept; on iOS
      // CallKit owns the ring and ends it itself. The bridge short-circuits
      // on `!isAndroid` before reaching here — present only to honor the
      // NativeCallNativePlugin contract.
      return { released: false };
    },

    async getAudioStatus() {
      try {
        return await IOSCallAudio.getStatus();
      } catch (e) {
        console.warn('[NativeCallBridge.iOS] getAudioStatus failed:', e);
        return { mode: 'MODE_NORMAL', isSpeakerOn: false, isBtScoOn: false };
      }
    },

    async getInviteThrottleSnapshot(): Promise<InviteThrottleSnapshot> {
      // PushKit is real-time and not subject to FCM-style throttling.
      // The bridge's wrapper short-circuits with `if (!isAndroid) return ...`
      // before calling this, so this branch is mostly dead code — but we
      // keep it to honor the NativeCallNativePlugin contract.
      return { records: [] };
    },

    addListener(event: string, cb: (data: unknown) => void): Promise<PluginListenerHandle> {
      // Map Android event names → IncomingCallKit event names and
      // unwrap the payload so the bridge sees the same `{callId, roomId?}`
      // shape it does on Android.
      switch (event) {
        case 'callAnswered':
          return IncomingCallKit.addListener('callAccepted', (e) => {
            // Release CallKit before the answer, i.e. before getUserMedia:
            // releasing after it (call 17, 2026-09-24) left the capture as
            // dead as with CallKit alive — WebKit's audio started under the
            // CallKit session and did not recover once it was gone.
            void releaseCallKitAudio().finally(() => cb(unwrapEvent(e)));
          });
        case 'callDeclined':
          return IncomingCallKit.addListener('callDeclined', (e) => {
            cb(unwrapEvent(e));
          });
        case 'callEnded':
          return IncomingCallKit.addListener('callEnded', (e) => {
            const ev = unwrapEvent(e);
            // Our own release of the CallKit record (see releasedToWebKit):
            // the WebRTC call goes on, so this is not a hangup.
            if (e.source === 'api' && releasedToWebKit.delete(ev.callId)) return;
            cb(ev);
          });
        case 'audioDevicesChanged':
          // No iOS-side equivalent in v1 (we expose only the synthetic
          // "default" device). Return a no-op handle so the bridge's
          // wire() still resolves cleanly. Future Task 4 enhancement
          // could surface AVAudioSession routeChangeNotification here.
          return Promise.resolve({ remove: () => Promise.resolve() });
        default:
          return Promise.resolve({ remove: () => Promise.resolve() });
      }
    },
  } as NativeCallNativePlugin;
}
