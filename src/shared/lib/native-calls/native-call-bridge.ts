import { registerPlugin } from '@capacitor/core';
import { isAndroid, isIOS, isNative } from '@/shared/lib/platform';
import { NativeWebRTC } from '@/shared/lib/native-webrtc/native-webrtc-bridge';
import { isInviteEventExpired } from './invite-ttl';
import {
  callIdNeedsRoomCorrelation,
  matchesPendingCallMarker,
  pendingCallMarkerIsFresh,
  pendingCallMarkerOf,
} from './pending-call-marker';
import type { PendingCallMarker } from './pending-call-marker';
import type {
  AudioProbeResult,
  AudioTimelineEntry,
  InviteThrottleRecord,
  InviteThrottleSnapshot,
  NativeCallNativePlugin,
} from './native-call-bridge.types';
import { nativeCallEventAppliesTo } from './native-call-event-scope';
import type { NativeCallEventTarget } from './native-call-event-scope';
import { createIOSNativeCallAdapter } from './native-call-bridge.ios';
import { withRetry } from './with-retry';

export type {
  AudioProbeResult,
  AudioTimelineEntry,
  InviteThrottleRecord,
  InviteThrottleSnapshot,
} from './native-call-bridge.types';

/** Native AudioRouter device identifiers (see `CallPlugin.setAudioDevice`). */
export type NativeAudioDeviceType = 'speaker' | 'earpiece' | 'bluetooth' | 'wired_headset';

/** Snapshot of the native AudioRouter routing state. */
export interface NativeAudioDevicesState {
  /** Active device type, lowercased (e.g. 'speaker'). Empty when unknown. */
  active: string;
  devices: Array<{ type: string; name: string }>;
}

const NativeCallAndroid = registerPlugin<NativeCallNativePlugin>('NativeCall');

/**
 * Per-platform native plugin handle. Android keeps the existing
 * `NativeCall` Kotlin plugin (CallPlugin.kt). iOS uses an adapter that
 * routes the same Android-shaped contract to
 * `@capgo/capacitor-incoming-call-kit` + `IOSCallAudio` — see
 * `native-call-bridge.ios.ts` and Step 6 plan tasks 1-4.
 *
 * Web/Electron: also picks the Android handle. The bridge's `if (!isNative)`
 * guards short-circuit before any plugin call would actually fire.
 */
const NativeCall: NativeCallNativePlugin = isIOS
  ? createIOSNativeCallAdapter()
  : NativeCallAndroid;

/**
 * What the user tapped "Answer" on natively — via push ringer
 * (`getPendingAnswer`) or live `callAnswered` event. Consumed by
 * call-service.handleIncomingCall to suppress the duplicate-ring.
 *
 * Two markers because the push-side `call_id` is often just the push
 * event_id on this homeserver, which does NOT match the Matrix SDK's
 * `call.callId`. For such an id only, we fall through to `roomId`: if the
 * user tapped Answer on a push-keyed ringer for room R, the first
 * MatrixCall we receive for room R is the one they accepted. A marker
 * holding a real Matrix callId matches that call alone.
 */
let pendingAnswer: PendingCallMarker | null = null;

/**
 * What to assume when the platform hands back a marker with no write time.
 *
 * iOS has none to give — its adapter reads live CallKit state instead of a
 * stored marker — and `null` keeps the un-aged behaviour there. On Android
 * the stamp is always written, so its absence means something is wrong; 0
 * makes `matchesPendingCallMarker` refuse the roomId fallback rather than
 * silently fall back to matching for ever. (JS and the Kotlin plugin ship
 * inside one APK, so they cannot drift apart in practice — this is a
 * belt-and-braces default, not a compatibility shim.)
 */
function missingStamp(): number | null {
  return isAndroid ? 0 : null;
}

/**
 * Tail of every retire still crossing the bridge. The native markers are
 * read-and-clear, so a peek that overtook a retire in flight would consume a
 * marker that is already meant to be gone — and act on it. Both consumers
 * await this before peeking, which makes the ordering explicit instead of
 * leaning on Capacitor's dispatch order.
 */
let markerRetireInFlight: Promise<void> = Promise.resolve();

/**
 * The key the native side knows JS's current call by, when JS was *told* it.
 *
 * A connection created from a push is keyed by the push's `call_id` — the
 * event_id on this homeserver — so its lifecycle events carry an id that can
 * never be compared with anything the SDK holds, and the room is all that is
 * left to correlate on. That collapses when two calls share a room, and the
 * connection key does not.
 *
 * Written ONLY from an exact id match, never from a room match. A room match
 * is a guess between "this marker was written for the call I am adopting" and
 * "this marker is a leftover from another connection in the same room inside
 * the 60 s window" — and the two are indistinguishable. Recording a guess here
 * would be far worse than the gap it closes: {@link nativeCallEventAppliesTo}
 * treats a known key as decisive, so one wrong binding withholds that call's
 * own teardown for the rest of its life — JS believing a call is live after
 * Telecom ended it is the "stuck in call mode" state that dominates the bug
 * reports. An exact id match is not a guess: markers are written under the
 * connection's own id, so a marker whose id equals the SDK call's id proves
 * the connection behind that call is keyed the same way.
 *
 * One entry, because JS holds one call at a time, and it is only ever read for
 * the call it was recorded against — so a binding left over from a finished
 * call is inert rather than wrong, and needs no separate expiry.
 *
 * A consequence of the exact-match rule: both fields always hold the same
 * string, so what is really recorded is "this call's connection is keyed by
 * its own Matrix id". The pair is kept because that is the question the reader
 * of {@link nativeCallEventAppliesTo} is asking, and because a rule that could
 * one day prove a different key would slot in here without touching either
 * call site.
 */
let nativeKeyBinding: { callId: string; nativeKey: string } | null = null;

/**
 * Record that native knows `matrixCallId` as `nativeKey`.
 *
 * Refuses anything but an exact match, so a caller cannot hand over a
 * room-correlated guess by accident. See the note above.
 */
function rememberNativeKey(
  matrixCallId: string | null | undefined,
  nativeKey: string | null | undefined,
): void {
  if (!matrixCallId || !nativeKey || matrixCallId !== nativeKey) return;
  nativeKeyBinding = { callId: matrixCallId, nativeKey };
}

/** The native key for `matrixCallId`, or undefined when JS was never told it. */
function nativeKeyFor(matrixCallId: string | null | undefined): string | undefined {
  if (!matrixCallId || nativeKeyBinding?.callId !== matrixCallId) return undefined;
  return nativeKeyBinding.nativeKey;
}

/**
 * Bumped on every arm of {@link NativeCallBridge.waitForMatrixCallAndAnswer} and
 * on every retire of the answer marker that drives one. Only the newest
 * generation may answer.
 */
let answerWaitGeneration = 0;

/**
 * Stop the wait an answer marker was driving.
 *
 * A wait exists to replay a decision the user already made on the native ringer.
 * Once that marker is retired the decision has been acted on, so a wait still
 * polling for the rest of its 30 s can only adopt a call the user never accepted.
 * That is reachable rather than theoretical: a push-keyed id keeps the room
 * fallback open, so the next invite in the same room matches.
 */
function cancelAnswerWait(): void {
  answerWaitGeneration++;
}

/**
 * Decide whether the given Matrix call is the one the user already
 * accepted via the native ringer, and consume the marker on match.
 *
 * Match order:
 *   1. exact callId equality (works when the push carries the real
 *      Matrix content.call_id, and always on the /sync path)
 *   2. roomId equality, only for a marker keyed by an event_id or by
 *      nothing — a push without call_id still carries room_id. A real
 *      callId that differs is a different call: on 2026-09-13 an answer
 *      for one call pre-accepted the next one from the same room.
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
  const matchAndClear = (marker: PendingCallMarker | null): boolean => {
    if (!marker || !matchesPendingCallMarker(marker, { callId, roomId })) return false;
    // Only an exact id match tells us anything about the connection behind
    // this call; the room branch above is a guess and rememberNativeKey
    // refuses it. See the note on nativeKeyBinding.
    rememberNativeKey(callId, marker.callId);
    pendingAnswer = null;
    // Whoever consumed this marker answers the call themselves, so a wait armed
    // for the same decision is redundant — and redundant is not harmless. The
    // wait matches against the marker it captured when it armed, not against
    // this slot, so it would go on matching by room for the rest of its 30 s
    // and could adopt a later call in that room that nobody accepted. This is
    // the common path, not the edge case: handleIncomingCall consumes the
    // marker for essentially every incoming call, which leaves nothing for the
    // retire in finalizeCall to find.
    cancelAnswerWait();
    return true;
  };

  if (matchAndClear(pendingAnswer)) return true;
  if (!isNative) return false;
  // A retire for a call that just ended may still be crossing the bridge;
  // the native markers are read-and-clear, so a peek that overtook one would
  // consume a marker already meant to be gone.
  await markerRetireInFlight;
  try {
    const {
      callId: nativeCall,
      roomId: nativeRoom,
      atMs: nativeAt,
    } = await NativeCall.getPendingAnswer();
    if (matchAndClear(pendingCallMarkerOf(nativeCall, nativeRoom, nativeAt ?? missingStamp()))) {
      return true;
    }
  } catch (e) {
    console.warn('[NativeCallBridge] consumePendingAnswerCallId peek failed:', e);
  }
  return false;
}

/**
 * Symmetric to the pending-answer marker but for the Decline path.
 * Populated from CallConnection.onReject in Kotlin when the user taps
 * Decline in the native ringer, consumed by handleIncomingCall so the
 * matrixCall can be rejected back to Matrix (the caller otherwise keeps
 * ringing until their lifetime timeout).
 */
let pendingReject: PendingCallMarker | null = null;

export async function consumePendingRejectCallId(
  callId: string,
  roomId?: string,
): Promise<boolean> {
  const matchAndClear = (marker: PendingCallMarker | null): boolean => {
    if (!marker || !matchesPendingCallMarker(marker, { callId, roomId })) return false;
    pendingReject = null;
    return true;
  };

  if (matchAndClear(pendingReject)) return true;
  if (!isNative) return false;
  // A retire for a call that just ended may still be crossing the bridge;
  // the native markers are read-and-clear, so a peek that overtook one would
  // consume a marker already meant to be gone.
  await markerRetireInFlight;
  try {
    const {
      callId: nativeCall,
      roomId: nativeRoom,
      atMs: nativeAt,
    } = await NativeCall.getPendingReject();
    if (matchAndClear(pendingCallMarkerOf(nativeCall, nativeRoom, nativeAt ?? missingStamp()))) {
      return true;
    }
  } catch (e) {
    console.warn('[NativeCallBridge] consumePendingRejectCallId peek failed:', e);
  }
  return false;
}

/**
 * Calls JS currently knows about, by callId. Entries arrive as JS tells native
 * about a call and leave as that call finalizes, so this is the set of live
 * calls from JS's point of view. It exists to answer one question for the
 * retire below: is there another call in this room that could still own a
 * marker?
 */
const liveCalls = new Map<string, { roomId?: string; at: number; seq: number }>();

/** Announcement order, so "announced before this one" needs no clock. */
let liveCallSeq = 0;

/**
 * A call that never finalizes would otherwise pin its room forever. Six hours
 * is far longer than any real call and far shorter than a session, so a
 * stranded entry heals on its own; until it does, the retire simply falls back
 * to matching on callId, which is what it did before this mechanism existed.
 */
const LIVE_CALL_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Records a call JS has just told native about. */
function noteCallSeen(callId: string | undefined, roomId?: string): void {
  if (!callId) return;
  const now = Date.now();
  for (const [id, entry] of liveCalls) {
    if (now - entry.at > LIVE_CALL_MAX_AGE_MS) liveCalls.delete(id);
  }
  if (!liveCalls.has(callId)) liveCalls.set(callId, { roomId, at: now, seq: ++liveCallSeq });
}

/**
 * Retire both markers for a call JS has finished with.
 *
 * A marker only has to carry a decision across a process that was not alive
 * to act on it. Once `finalizeCall` has run, JS has acted — and a marker left
 * behind reaches the NEXT invite from that room through the roomId fallback:
 * a queued answer picks it up with no ringer at all, a queued reject declines
 * it unheard. Both were seen on the Samsung bench on 2026-09-09.
 *
 * Matches on callId OR roomId, and the room is the load-bearing half. A
 * connection created from a push is keyed by the push's call_id, which this
 * homeserver fills with the event_id — it can never equal the Matrix callId
 * a finalize carries, so on the push path, which is the primary ringer
 * surface, callId alone would retire nothing at all. The room is the only key
 * the two paths share.
 *
 * The room match is withheld while another call JS knows about is still live
 * in that room, so finishing one call cannot erase a marker a newer one still
 * needs. Exact callId matches stay unconditional.
 */
export async function retirePendingMarkers(callId: string, roomId?: string): Promise<void> {
  if (!callId && !roomId) return;
  const own = callId ? liveCalls.get(callId) : undefined;
  if (callId) liveCalls.delete(callId);
  // A push-delivered call is announced twice: once by the push handler under
  // `call_id`, which this homeserver fills with the event_id, and again under
  // the Matrix callId once /sync delivers the invite. Only the second id can
  // ever reach a finalize, so the first twin would sit in the map and make its
  // room look busy for hours — disabling the room match on exactly the path
  // that needs it. Sweeping the room's entries announced BEFORE the one being
  // finalized clears the twin and leaves anything newer alone. Order, not a
  // clock: the two announcements can land in the same millisecond.
  if (roomId && own) {
    for (const [id, entry] of liveCalls) {
      if (entry.roomId === roomId && entry.seq < own.seq) liveCalls.delete(id);
    }
  }
  // Match on the room only while no OTHER call JS knows about is live in it.
  // A marker cannot belong to a call that does not exist, and this is what
  // stops one finished call from erasing the marker of a newer one in the
  // same room — the case Telecom makes real by displacing a still-ringing
  // connection for a same-room re-invite. Timestamps cannot answer this: the
  // marker is written when the user taps, which is often AFTER JS already
  // knew the call being finalized.
  const roomIsClear =
    !!roomId && ![...liveCalls.values()].some((entry) => entry.roomId === roomId);
  const byRoom = roomIsClear ? roomId : undefined;
  const spent = (marker: PendingCallMarker | null): boolean =>
    !!marker &&
    ((!!callId && marker.callId === callId) || (!!byRoom && marker.roomId === byRoom));
  if (spent(pendingAnswer)) {
    pendingAnswer = null;
    // Precisely scoped: `spent` already decided this marker belongs to the
    // call being retired, so a wait armed for a different call is untouched.
    cancelAnswerWait();
  }
  if (spent(pendingReject)) pendingReject = null;
  if (!isNative) return;
  const done = NativeCall.retirePendingMarkers({ callId, roomId: byRoom }).catch((e: unknown) => {
    // Best effort, as everywhere else on this bridge. The room-scoped TTL
    // still caps how long a marker that survives this can do damage.
    console.warn('[NativeCallBridge] retirePendingMarkers failed:', e);
  });
  markerRetireInFlight = markerRetireInFlight.then(() => done);
  await done;
}

/**
 * What the bridge needs from the call service.
 *
 * Typed rather than `any` because the guard below reads `currentCall` off this
 * field: an accessor lost to a rename would leave the optional chain returning
 * undefined, which reads as "JS holds nothing" and silently restores the
 * unscoped teardown this guard exists to prevent. The `wire()` contract can
 * only police its own call site; the field type polices every use.
 */
interface BridgeCallService {
  answerCall: () => void;
  rejectCall: () => void;
  hangup: () => void;
  /**
   * The call `rejectCall`/`hangup` would act on right now, with an undefined
   * `callId` when JS holds none. Required, not optional: an absent accessor
   * would silently restore the unscoped teardown rather than fail a call site.
   */
  currentCall: () => NativeCallEventTarget;
  /** Android only — the native CallActivity's video toggle. */
  setLocalVideoMuted?: (muted: boolean) => void;
  /**
   * Native answered a call that never reached JS (the caller hung up as the
   * user tapped Accept): release its Telecom connection and screens.
   */
  releaseOrphanedNativeAnswer?: (callId: string, roomId?: string) => void;
}

class NativeCallBridge {
  private callService: BridgeCallService | null = null;
  /**
   * wire() runs on every Matrix init — a re-login or account switch without a
   * page reload — and each run used to add another set of listeners, so a
   * native hangup or video toggle ran twice (two concurrent upgradeCall).
   * The handlers read `this.callService`, so one set serves every wire().
   */
  private listenersAdded = false;
  /**
   * WEE-16: signal aborted by stop/forceStop so any in-flight
   * `startAudioRouting` retry bails immediately. Without this, a user
   * who hangs up during the retry backoff would see the retry resume
   * after AudioRouter.stop() ran — leaving the device stuck in
   * MODE_IN_COMMUNICATION until the Session 54 orphan watchdog (~5 min).
   * Recreated on each `startAudioRouting` call so each call cycle has
   * its own cancellation token.
   */
  private audioRoutingAbort: AbortController | null = null;

  /**
   * True when a native call-lifecycle event may act on the call JS holds now.
   *
   * The listeners below command `callService`, which acts on
   * `callStore.matrixCall` — so the id is read off that same service, in the
   * same synchronous turn as the command. Anything looser (a dynamic store
   * import, a value cached at wire time) reintroduces the window this guard
   * exists to close: on the Samsung the wrong call was torn down 3 ms after
   * being offered.
   */
  private eventNamesCurrentCall(
    event: string,
    target: NativeCallEventTarget,
  ): boolean {
    const held = this.callService?.currentCall() ?? { callId: undefined };
    const current: NativeCallEventTarget = {
      ...held,
      nativeKey: nativeKeyFor(held.callId),
    };
    if (nativeCallEventAppliesTo(target, current)) return true;
    console.log(
      '[NativeCallBridge] ' + event + ' names ' + target.callId + ' in ' +
        target.roomId + ', but JS holds ' + current.callId + ' in ' +
        current.roomId + ' — ignoring',
    );
    return false;
  }

  async wire(callService: BridgeCallService): Promise<void> {
    if (!isNative) return;
    this.callService = callService;

    // Request audio permission early so WebRTC can access microphone
    try {
      await NativeCall.requestAudioPermission();
    } catch (e) {
      console.warn('[NativeCallBridge] requestAudioPermission failed:', e);
    }

    const addListeners = !this.listenersAdded;
    this.listenersAdded = true;

    if (addListeners) {
      await NativeCall.addListener('callAnswered', ({ callId, roomId }) => {
        console.log('[NativeCallBridge] Call answered:', callId, 'room:', roomId);
        // Record the accept so handleIncomingCall on the JS side knows
        // to skip the duplicate-ring path and go straight to answered.
        // BOTH callId and roomId are needed because a push without call_id
        // keys the connection by its event_id, which will NEVER match the
        // Matrix SDK's call.callId. For such an id the roomId fallback is how
        // we correlate the pending accept with the MatrixCall.
        // Assigned whole: this event names one call, so its room travels with
        // its id. Keeping a previous call's room here and re-stamping it is
        // exactly how a stale marker used to swallow an unrelated later call.
        // Written on this side rather than natively, hence the local clock.
        pendingAnswer = pendingCallMarkerOf(callId, roomId, Date.now());
        this.waitForMatrixCallAndAnswer(callId, roomId, pendingAnswer);
      });

      await NativeCall.addListener('callDeclined', ({ callId, roomId }) => {
        console.log('[NativeCallBridge] Call declined:', callId);
        if (!this.eventNamesCurrentCall('callDeclined', { callId, roomId })) return;
        this.callService?.rejectCall();
      });

      await NativeCall.addListener('callEnded', ({ callId, roomId }) => {
        console.log('[NativeCallBridge] Call ended natively:', callId);
        if (!this.eventNamesCurrentCall('callEnded', { callId, roomId })) return;
        this.callService?.hangup();
      });
    }

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
      const {
        callId: pendingCallId,
        roomId: pendingRoomId,
        atMs: pendingAtMs,
      } = await NativeCall.getPendingAnswer();
      if (pendingCallId) {
        const marker = pendingCallMarkerOf(
          pendingCallId,
          pendingRoomId,
          pendingAtMs ?? missingStamp(),
        );
        // Seeded whatever its age: an exact callId still names the very call
        // the user tapped, and `matchesPendingCallMarker` honours that with no
        // time bound. Only the *replay* below is age-gated.
        pendingAnswer = marker;
        // A replay is speculative — there is no invite in hand to compare ids
        // with, so this arms a poll that will answer whatever shows up. Past
        // one invite lifetime nothing legitimate can still be waiting: the SDK
        // has expired the invite itself. Observed on a Samsung 2026-09-09 —
        // the user swiped the app away mid-call, so nothing retired the marker
        // `onAnswer` had written; the next app start replayed it 141 s later
        // and the poll picked up an entirely unrelated call from that room,
        // with no ringer and the mic open.
        if (marker && !pendingCallMarkerIsFresh(marker)) {
          console.warn(
            '[NativeCallBridge] Discarding a stale queued answer (age ' +
              (typeof pendingAtMs === 'number' ? Date.now() - pendingAtMs : 'unknown') + 'ms):',
            pendingCallId,
          );
          // Nothing to retire natively: getPendingAnswer is read-and-clear, so
          // the read above already took it.
        } else {
          console.log('[NativeCallBridge] Pending answer queued, waiting for matrixCall:', pendingCallId, 'room:', pendingRoomId);
          this.waitForMatrixCallAndAnswer(pendingCallId, pendingRoomId ?? undefined, marker);
        }
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
      const {
        callId: rejectCallId,
        roomId: rejectRoomId,
        atMs: rejectAtMs,
      } = await NativeCall.getPendingReject();
      if (rejectCallId || rejectRoomId) {
        console.log('[NativeCallBridge] Pending reject queued:', rejectCallId, 'room:', rejectRoomId);
        pendingReject = pendingCallMarkerOf(
          rejectCallId,
          rejectRoomId,
          rejectAtMs ?? missingStamp(),
        );
      }
    } catch (e) {
      console.warn('[NativeCallBridge] getPendingReject failed:', e);
    }

    // The two NativeWebRTC listeners below are fed by Android's
    // CallActivity (full-screen call surface) — the user tapping the
    // hangup or video-toggle buttons inside the native window. iOS
    // does not have a native call surface (CallKit owns the lock-screen
    // ringer; the in-call UI runs in WKWebView), and the JS-side
    // NativeWebRTC proxy is gated behind `if (isAndroid)` in
    // call-service.ts (Step 5 / webrtc-decision.md). Registering these
    // listeners on iOS would target a no-op Capacitor handle and emit
    // "UNIMPLEMENTED" warnings on every call setup. Skip cleanly.
    if (isAndroid && addListeners) {
      // Native CallActivity hangup button → proper SDK hangup
      await NativeWebRTC.addListener('onNativeHangup', () => {
        console.log('[NativeCallBridge] Native UI hangup');
        this.callService?.hangup();
      });

      // Native CallActivity video toggle → SDK renegotiation
      await NativeWebRTC.addListener('onNativeVideoToggle', ({ enabled }) => {
        console.log('[NativeCallBridge] Native video toggle:', enabled);
        this.callService?.setLocalVideoMuted?.(!enabled);
      });
    }
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
  private waitForMatrixCallAndAnswer(
    callId: string,
    roomId?: string,
    marker?: PendingCallMarker | null,
  ): void {
    // Only the newest wait may answer. Two sites arm one — wire()'s replay and
    // the callAnswered listener — and neither used to hold a handle or stop on
    // answer or hangup, so a poll armed for one call kept running for its full
    // 30 s and could still fire on a later, unrelated one. In the Samsung
    // swipe-away repro the poll armed at 23:04:41.913 answered at 23:04:52.503:
    // eleven seconds and a different call later.
    const generation = ++answerWaitGeneration;
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
      // Abandoning a superseded wait also abandons its recovery pass below.
      // That is safe because the recovery is not the only route: whenever it
      // has already re-emitted Call.incoming, handleIncomingCall consumes the
      // same module-level marker through consumePendingAnswerCallId and
      // answers from there, independently of any wait.
      if (generation !== answerWaitGeneration) return;
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
        // ...but only for a marker whose own id cannot be compared. A push id
        // is really an event_id and never equals `call.callId`, so there the
        // room is the only correlator we have. When the connection was created
        // from /sync the marker carries the real Matrix callId instead, and
        // widening that to the room only ever lets it claim someone else's
        // call — which is exactly what happened on the Samsung bench. The test
        // is the id itself, not which path created the connection: a
        // push-created one is keyed by the event_id and keeps its fallback.
        // Re-checked every tick, not just at arm time: the poll runs for 30 s,
        // and a marker that was 55 s old when it armed must not still be
        // claiming calls 20 s later. Bounding it by the marker's own age caps
        // the room fallback at one invite lifetime from the user's tap, which
        // is the same rule matchesPendingCallMarker applies.
        const roomStillFresh = !marker || pendingCallMarkerIsFresh(marker);
        const matchByRoom =
          callIdNeedsRoomCorrelation(callId) &&
          roomStillFresh &&
          !!roomId &&
          !!current?.roomId &&
          current.roomId === roomId;
        if (current && (matchById || matchByRoom)) {
          // Same rule as consumePendingAnswerCallId: only the exact-id arm of
          // this match says anything about the connection behind the call, and
          // rememberNativeKey drops the room-matched case on its own.
          rememberNativeKey(current.callId, callId);
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
        // The connection was answered natively and nothing in JS will ever end
        // it: it stayed ACTIVE, and every later call was refused as busy.
        this.callService?.releaseOrphanedNativeAnswer?.(callId, roomId);
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
        | { callEventHandler?: { onRoomTimeline: (e: unknown) => void; onSync: () => void }; getRooms?: () => Array<{ getLiveTimeline?: () => { getEvents?: () => Array<{ getType: () => string; getTs?: () => number; getContent: () => Record<string, unknown> }> } }> }
        | undefined;
      if (!client?.callEventHandler || !client.getRooms) return false;

      for (const room of client.getRooms()) {
        const events = room.getLiveTimeline?.()?.getEvents?.() ?? [];
        for (const event of events) {
          const type = event.getType();
          if (type !== 'm.call.invite' && !type.startsWith('org.matrix.call.')) continue;
          const content = event.getContent();
          if ((content as { call_id?: string }).call_id !== callId) continue;

          // Session 25 / S4: stale-invite filter. The SDK's own
          // initWithInvite arms a timer that fires Hangup the moment the
          // invite age exceeds `content.lifetime`, but feeding the same
          // event into onRoomTimeline still triggers a one-tick UI flash
          // (Vue ringer template renders, then collapses) AND a native
          // CallActivity launch on Android. On the cold-start-from-push
          // path this manifests as the user opening the app to find a
          // brief "ringing" surface for a call the caller cancelled
          // minutes ago. Skip expired invites here so the recovery path
          // does not republish them into the active surface.
          const originServerTs = typeof event.getTs === 'function' ? event.getTs() : 0;
          const lifetime = (content as { lifetime?: number | null }).lifetime ?? null;
          if (isInviteEventExpired({ originServerTs, lifetime })) {
            console.warn(
              '[NativeCallBridge] feedMissedInviteToSDK: skipping expired invite',
              { callId, originServerTs, lifetime },
            );
            return false;
          }

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
    noteCallSeen(options.callId, options.roomId);
    if (!isNative) return;
    await NativeCall.reportIncomingCall(options);
  }

  /**
   * WEE-31: launch the native ringer surface only if one isn't already
   * showing. Use this from `handleIncomingCall` on isNative so that
   * sync-first deliveries (app in foreground → Matrix /sync wins the
   * race against FCM) still get a ringer. Older native builds that
   * don't ship `ensureIncomingCallVisible` are handled by falling
   * back to {@link reportIncomingCall}.
   */
  async ensureIncomingCallVisible(options: {
    callId: string;
    callerName: string;
    roomId: string;
    hasVideo: boolean;
  }): Promise<void> {
    noteCallSeen(options.callId, options.roomId);
    if (!isNative) return;
    try {
      const plugin = NativeCall as Partial<NativeCallNativePlugin>;
      if (typeof plugin.ensureIncomingCallVisible === 'function') {
        await plugin.ensureIncomingCallVisible(options);
        return;
      }
    } catch (e) {
      console.warn('[NativeCallBridge] ensureIncomingCallVisible failed, falling back:', e);
    }
    // Older native build — best-effort fall back to reportIncomingCall.
    // It's not perfectly idempotent (it can stack a second Telecom call
    // if one is already up), so on the cold-start-from-push path it can
    // raise a *second* answer dialog on top of the IncomingCallActivity the
    // FCM handler already launched — exactly the duplicate-ringer bug in
    // forta-bugs#832 / #893 (WEE-63). Guard it: if the SDK already tracks
    // this callId, the push path has (or is about to) surface a ringer, so
    // skip the non-idempotent fallback rather than stack a duplicate.
    if (await this.sdkHasCall(options.callId)) {
      console.warn(
        '[NativeCallBridge] skipping non-idempotent reportIncomingCall fallback — SDK already has call:',
        options.callId,
      );
      return;
    }
    try {
      await NativeCall.reportIncomingCall(options);
    } catch (e) {
      console.warn('[NativeCallBridge] fallback reportIncomingCall failed:', e);
    }
  }

  async reportOutgoingCall(options: {
    callId: string;
    callerName: string;
    hasVideo: boolean;
  }): Promise<void> {
    noteCallSeen(options.callId, undefined);
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
   *
   * WEE-16: the bridge used to swallow transient failures with a single
   * `console.warn`. On Android the underlying `audioManager.mode` setter
   * can throw a transient `SecurityException` / `IllegalStateException`
   * immediately after `call.answer()` if the call foreground service
   * has not yet bound — leaving the device in MODE_NORMAL for the rest
   * of the conversation and the peer hearing silence. We now retry on
   * a short backoff so a single transient hiccup does not silently kill
   * audio for the whole call.
   */
  async startAudioRouting(options: { callType: string }): Promise<void> {
    if (!isNative) return;
    // Abort any in-flight retry from a previous call cycle so we don't
    // double-arm AudioRouter. Then create a fresh controller scoped to
    // this call cycle; `stopAudioRouting`/`forceStopAudio` will abort it.
    this.audioRoutingAbort?.abort();
    const controller = new AbortController();
    this.audioRoutingAbort = controller;
    const result = await withRetry(
      () => NativeCall.startAudioRouting(options),
      {
        delaysMs: [150, 400, 800],
        label: 'startAudioRouting',
        signal: controller.signal,
      },
    );
    if (result.outcome === 'failure') {
      console.warn(
        '[NativeCallBridge] startAudioRouting failed after',
        result.attempts,
        'attempts:',
        result.error,
      );
    } else if (result.outcome === 'aborted') {
      console.warn(
        '[NativeCallBridge] startAudioRouting aborted after',
        result.attempts,
        'attempts (hangup during backoff)',
      );
    } else if (result.attempts > 1) {
      console.warn(
        '[NativeCallBridge] startAudioRouting recovered on attempt',
        result.attempts,
      );
    }
  }

  /**
   * WEE-60: route in-call audio to a specific output through the native
   * AudioRouter. `type` is one of 'speaker' | 'earpiece' | 'bluetooth' |
   * 'wired_headset' (see `CallPlugin.setAudioDevice` → `AudioRouter.setDevice`).
   *
   * No-op on web: the WebView has no AudioManager, and web output selection is
   * handled by `setSinkId` on the remote element in CallWindow. Surfaced here so
   * the Vue speaker toggle has a typed entry point instead of reaching into the
   * raw Capacitor plugin.
   */
  async setAudioDevice(options: { type: NativeAudioDeviceType }): Promise<boolean> {
    if (!isNative) return false;
    try {
      await NativeCall.setAudioDevice(options);
      return true;
    } catch (e) {
      // The native router refuses a route while it is not running (reject
      // code `router_inactive`). The caller owns the optimistic UI state,
      // so the refusal is returned rather than swallowed.
      console.warn('[NativeCallBridge] setAudioDevice failed:', e);
      return false;
    }
  }

  /**
   * WEE-60: read the native AudioRouter's current routing snapshot. Used to
   * seed the in-call speaker-toggle state on mount so it reflects the real
   * output (the call may have opened on speaker for video, or BT may already
   * be connected). Safe default on web / older native builds.
   */
  async getAudioDevices(): Promise<NativeAudioDevicesState> {
    if (!isNative) return { active: '', devices: [] };
    try {
      const res = await NativeCall.getAudioDevices();
      return {
        active: typeof res?.active === 'string' ? res.active : '',
        devices: Array.isArray(res?.devices) ? res.devices : [],
      };
    } catch (e) {
      console.warn('[NativeCallBridge] getAudioDevices unavailable:', e);
      return { active: '', devices: [] };
    }
  }

  /**
   * WEE-60: subscribe to native AudioRouter routing changes (BT/wired hot-swap,
   * OEM auto-routing). Keeps the speaker toggle in sync with the actual output
   * instead of drifting after minimize/restore or a headset connect. Returns an
   * unsubscribe function; no-op on web / older native builds.
   */
  async onAudioDevicesChanged(
    cb: (state: NativeAudioDevicesState) => void,
  ): Promise<() => void> {
    if (!isNative) return () => {};
    try {
      const handle = await NativeCall.addListener('audioDevicesChanged', (data) => {
        cb({
          active: typeof data?.active === 'string' ? data.active : '',
          devices: Array.isArray(data?.devices) ? data.devices : [],
        });
      });
      return () => {
        try {
          handle.remove();
        } catch {
          /* listener already detached */
        }
      };
    } catch (e) {
      console.warn('[NativeCallBridge] onAudioDevicesChanged unavailable:', e);
      return () => {};
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
    // WEE-16: abort any pending startAudioRouting retry before tearing
    // down. Otherwise a retry scheduled during a transient failure can
    // fire AudioRouter.start() right after we stopped it.
    this.audioRoutingAbort?.abort();
    this.audioRoutingAbort = null;
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
    // WEE-16: same abort wiring as stopAudioRouting — the brute reset
    // path must also kill in-flight retries.
    this.audioRoutingAbort?.abort();
    this.audioRoutingAbort = null;
    try {
      await NativeCall.forceStopAudio();
    } catch (e) {
      console.warn('[NativeCallBridge] forceStopAudio failed:', e);
    }
  }

  /**
   * Ask native to release a Telecom connection that has been ringing past
   * its deadline, and report whether it found one.
   *
   * The resume watchdog can recover a stranded MODE_IN_COMMUNICATION by
   * resetting the audio mode, but MODE_RINGTONE — where most "the phone is
   * stuck after a call" reports were filed from — is held by Telecom on
   * behalf of our own connection, and a real cellular call ringing sets the
   * same mode. Resetting it blindly would break the system ringer, so the
   * recovery is to release our connection and let Telecom drop the mode.
   * The staleness bar lives natively (StaleCallPolicy) so a call the user is
   * about to answer is never touched.
   *
   * Android only, and safe on builds that predate the plugin method: a
   * Capacitor "not implemented" rejection means there is nothing to release.
   */
  async releaseStaleRingingCall(): Promise<boolean> {
    if (!isAndroid) return false;
    try {
      const result = await NativeCall.releaseStaleRingingCall();
      return result?.released === true;
    } catch (e) {
      console.warn('[NativeCallBridge] releaseStaleRingingCall unavailable:', e);
      return false;
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

  /**
   * Ordered audio-stack events for the current call, oldest first, times
   * relative to the first entry. Attached to bug reports so triage can see
   * how the audio stack reached its final state instead of only the state
   * itself — a device that never left MODE_RINGTONE and one that fell back
   * into it after hangup are indistinguishable in a snapshot.
   *
   * Android only. iOS drives audio through AVAudioSession, which has its own
   * (separately reported) lifecycle; an empty list keeps the report envelope
   * shape identical across platforms. An older native build without the
   * plugin method surfaces as a Capacitor "not registered" rejection, which
   * is likewise an empty list — a bug report must never fail to submit
   * because diagnostics are unavailable.
   */
  async getAudioTimeline(): Promise<AudioTimelineEntry[]> {
    if (!isAndroid) return [];
    try {
      const result = await NativeCall.getAudioTimeline();
      return Array.isArray(result?.entries) ? result.entries : [];
    } catch (e) {
      console.warn('[NativeCallBridge] getAudioTimeline unavailable:', e);
      return [];
    }
  }

  /**
   * Session 25 / S3-S4: pull the last N FCM `m.call.invite` records for
   * the bug-reporter envelope. Returns an empty list on non-native
   * platforms or when the native plugin is older than this build (the
   * Capacitor bridge surfaces a "method not registered" error there).
   *
   * iOS short-circuits to the empty list. The metric is FCM-throttle
   * telemetry from the Android FortaFirebaseMessagingService — iOS
   * uses PushKit, which is real-time and not subject to the FCM
   * data-message throttle. Sygnal also routes `m.call.invite` over
   * APNs VoIP class on iOS (Step 6 Task 3 / fortaios.voip pusher),
   * which has its own latency profile but no throttle bucket. Skipping
   * the native call avoids a guaranteed-empty round-trip on every
   * bug-report submission.
   */
  async getInviteThrottleSnapshot(): Promise<InviteThrottleSnapshot> {
    if (!isAndroid) return { records: [] };
    try {
      const res = await NativeCall.getInviteThrottleSnapshot();
      const records = Array.isArray(res?.records) ? res.records : [];
      return { records };
    } catch (e) {
      console.warn('[NativeCallBridge] getInviteThrottleSnapshot unavailable:', e);
      return { records: [] };
    }
  }
}

export const nativeCallBridge = new NativeCallBridge();
