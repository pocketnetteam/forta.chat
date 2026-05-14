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
export function createIOSNativeCallAdapter(): NativeCallNativePlugin {
  // Tracks every active call so endCall() can be no-throw idempotent
  // and so we can derive a CallKit handle (CallKit needs SOMETHING
  // non-empty in the `handle` field even for our generic chat handles).
  const knownCalls = new Map<
    string,
    { roomId: string; callerName: string; hasVideo: boolean }
  >();

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

    async getPendingAnswer() {
      try {
        const { calls } = await IncomingCallKit.getActiveCalls();
        // First accepted (cold-start) call wins. CallKit can't have
        // more than one "accepted" call at a time on iOS without
        // CallGrouping, which we don't enable.
        const accepted = calls.find((c) => c.state === 'accepted');
        if (!accepted) return { callId: null, roomId: null };
        const roomIdRaw = accepted.extra?.roomId;
        const roomId =
          typeof roomIdRaw === 'string' && roomIdRaw.length > 0 ? roomIdRaw : null;
        return { callId: accepted.callId, roomId };
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
        const declined = calls.find((c) => c.state === 'ended');
        if (!declined) return { callId: null, roomId: null };
        const roomIdRaw = declined.extra?.roomId;
        const roomId =
          typeof roomIdRaw === 'string' && roomIdRaw.length > 0 ? roomIdRaw : null;
        return { callId: declined.callId, roomId };
      } catch (e) {
        console.warn('[NativeCallBridge.iOS] getPendingReject failed:', e);
        return { callId: null, roomId: null };
      }
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
            cb(unwrapEvent(e));
          });
        case 'callDeclined':
          return IncomingCallKit.addListener('callDeclined', (e) => {
            cb(unwrapEvent(e));
          });
        case 'callEnded':
          return IncomingCallKit.addListener('callEnded', (e) => {
            cb(unwrapEvent(e));
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
