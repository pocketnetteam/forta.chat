import { describe, it, expect, vi, type Mock } from 'vitest';
import { PENDING_MARKER_ROOM_TTL_MS } from './pending-call-marker';

/**
 * A pending answer/reject marker must not outlive the call it belongs to.
 *
 * Found on the Samsung bench 2026-09-09: the ringer's 30 s auto-reject left a
 * marker nobody consumed, and the next call from the same room — a fresh
 * callId, 5.5 minutes later — was rejected before it ever rang. The roomId
 * fallback cannot simply be dropped (the push payload's call_id is an
 * event_id, so on cold-start-from-push the room is the only correlation), so
 * the marker carries its write time and ages out instead.
 */

const ROOM = '!XfcsFwyJkEXLRTnPzc:matrix.pocketnet.app';
const PUSH_EVENT_ID = '$ZM8kQ5-push-event-id';
const MATRIX_CALL_ID = '17889559802696wWSVJYT0cFnIWQt';
/** The next call from the same room, as in the 2026-09-13 Samsung run. */
const NEXT_CALL_ID = '1789256297487pwCMsMV2ry9FSHda';

const android = {
  isNative: true,
  isAndroid: true,
  isIOS: false,
  isElectron: false,
  isWeb: false,
  currentPlatform: 'android' as const,
};

type NativeListeners = Record<string, (payload: { callId: string; roomId?: string }) => void>;

interface BridgeMocks {
  /** Captures the handlers wire() registers, so a test can fire one. */
  listeners?: NativeListeners;
  retirePendingMarkers?: Mock;
  /** What `callStore.matrixCall` holds; a function is re-read on every tick. */
  matrixCall?:
    | { callId?: string; roomId?: string }
    | null
    | (() => { callId?: string; roomId?: string } | null);
}

async function loadBridge(answer: Mock, reject: Mock, mocks: BridgeMocks = {}) {
  vi.resetModules();
  vi.doMock('@capacitor/core', () => ({
    registerPlugin: (name: string) => {
      if (name === 'NativeCall') {
        return {
          getPendingAnswer: answer,
          getPendingReject: reject,
          retirePendingMarkers:
            mocks.retirePendingMarkers ?? vi.fn().mockResolvedValue(undefined),
          addListener: vi.fn((event: string, handler: (p: { callId: string }) => void) => {
            if (mocks.listeners) mocks.listeners[event] = handler;
            return Promise.resolve({ remove: vi.fn() });
          }),
          requestAudioPermission: vi.fn().mockResolvedValue({ granted: true }),
          ensureIncomingCallVisible: vi.fn().mockResolvedValue(undefined),
          reportIncomingCall: vi.fn().mockResolvedValue(undefined),
        };
      }
      return new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) });
    },
  }));
  // The callAnswered listener kicks off a poll for the MatrixCall; give it
  // one that matches so the poll finishes on its first tick.
  const matrixCall =
    'matrixCall' in mocks ? mocks.matrixCall : { callId: MATRIX_CALL_ID, roomId: ROOM };
  vi.doMock('@/entities/call', () => ({
    useCallStore: () => ({
      get matrixCall() {
        return typeof matrixCall === 'function' ? matrixCall() : matrixCall;
      },
    }),
  }));
  vi.doMock('@/shared/lib/platform', () => android);
  vi.doMock('@/shared/lib/native-webrtc/native-webrtc-bridge', () => ({
    NativeWebRTC: { addListener: vi.fn() },
  }));
  vi.doMock('@capacitor/camera', () => ({ Camera: { requestPermissions: vi.fn() } }));
  return await import('./native-call-bridge');
}

const noMarker = () => vi.fn().mockResolvedValue({ callId: null, roomId: null, atMs: 0 });

/** A native marker written `ageMs` ago, whose callId cannot match Matrix's. */
const markerAged = (ageMs: number) =>
  vi.fn().mockResolvedValue({
    callId: PUSH_EVENT_ID,
    roomId: ROOM,
    atMs: Date.now() - ageMs,
  });

/** A native marker written `ageMs` ago for a call keyed by its real Matrix callId. */
const markerForCall = (callId: string, ageMs: number) =>
  vi.fn().mockResolvedValue({ callId, roomId: ROOM, atMs: Date.now() - ageMs });

describe('consumePendingRejectCallId', () => {
  it('rejects the call the user declined moments ago (cold start from push)', async () => {
    const { consumePendingRejectCallId } = await loadBridge(noMarker(), markerAged(3_000));

    await expect(consumePendingRejectCallId(MATRIX_CALL_ID, ROOM)).resolves.toBe(true);
  });

  it('leaves a later call from the same room alone once the marker has aged out', async () => {
    const staleByMinutes = markerAged(5 * 60_000 + 37_000);
    const { consumePendingRejectCallId } = await loadBridge(noMarker(), staleByMinutes);

    await expect(consumePendingRejectCallId(MATRIX_CALL_ID, ROOM)).resolves.toBe(false);
  });

  it('still rejects the exact call named by an old marker', async () => {
    const old = vi.fn().mockResolvedValue({
      callId: MATRIX_CALL_ID,
      roomId: ROOM,
      atMs: Date.now() - 10 * 60_000,
    });
    const { consumePendingRejectCallId } = await loadBridge(noMarker(), old);

    await expect(consumePendingRejectCallId(MATRIX_CALL_ID, ROOM)).resolves.toBe(true);
  });

  it('holds the room fallback right up to the TTL', async () => {
    const { consumePendingRejectCallId } = await loadBridge(
      noMarker(),
      markerAged(PENDING_MARKER_ROOM_TTL_MS - 5_000),
    );

    await expect(consumePendingRejectCallId(MATRIX_CALL_ID, ROOM)).resolves.toBe(true);
  });

  it('does not reject the next call from the same room on a fresh decline for another call', async () => {
    const { consumePendingRejectCallId } = await loadBridge(
      noMarker(),
      markerForCall(MATRIX_CALL_ID, 3_000),
    );

    await expect(consumePendingRejectCallId(NEXT_CALL_ID, ROOM)).resolves.toBe(false);
  });
});

describe('markers seeded by wire()', () => {
  // The production sequence during a live session: wire() reads the markers
  // once at boot and keeps them in module state, so a later consume resolves
  // against that copy rather than peeking at native again. The stamp has to
  // survive that hop or the marker silently becomes ageless.
  const callService = { answerCall: vi.fn(), rejectCall: vi.fn(), hangup: vi.fn(), currentCall: () => ({ callId: undefined }) };

  it('ages out a stale reject marker that wire() carried over', async () => {
    const stale = markerAged(5 * 60_000 + 37_000);
    const mod = await loadBridge(noMarker(), stale);
    await mod.nativeCallBridge.wire(callService);
    stale.mockResolvedValue({ callId: null, roomId: null, atMs: 0 });

    await expect(mod.consumePendingRejectCallId(MATRIX_CALL_ID, ROOM)).resolves.toBe(false);
  });

  it('a re-run of wire() does not leave a previous call\'s room behind', async () => {
    // wire() runs on every login, and module state outlives it. A native
    // marker naming a call but no room used to overwrite only the callId and
    // the stamp, leaving the earlier call's room paired with a fresh time —
    // and the room fallback would then swallow an unrelated call.
    const answer = vi.fn().mockResolvedValue({
      callId: PUSH_EVENT_ID,
      roomId: ROOM,
      atMs: Date.now() - 4_000,
    });
    const mod = await loadBridge(answer, noMarker());
    await mod.nativeCallBridge.wire(callService);

    answer.mockResolvedValue({ callId: 'later-call', roomId: null, atMs: Date.now() });
    await mod.nativeCallBridge.wire(callService);
    answer.mockResolvedValue({ callId: null, roomId: null, atMs: 0 });

    await expect(mod.consumePendingAnswerCallId(MATRIX_CALL_ID, ROOM)).resolves.toBe(false);

    // The second wire() armed a 30 s poll on real timers for 'later-call',
    // which no matrixCall here ever satisfies. Left running, its ticks import
    // modules in the middle of later tests, and under load that import can
    // re-register an older test's vi.doMock factory over a newer one — the
    // next test then reads a marker it never set up.
    await mod.retirePendingMarkers('later-call');
  });

  it('still honours a fresh reject marker that wire() carried over', async () => {
    const fresh = markerAged(4_000);
    const mod = await loadBridge(noMarker(), fresh);
    await mod.nativeCallBridge.wire(callService);
    fresh.mockResolvedValue({ callId: null, roomId: null, atMs: 0 });

    await expect(mod.consumePendingRejectCallId(MATRIX_CALL_ID, ROOM)).resolves.toBe(true);
  });
});

describe('markers retire with the call they belong to', () => {
  const callService = { answerCall: vi.fn(), rejectCall: vi.fn(), hangup: vi.fn(), currentCall: () => ({ callId: undefined }) };

  /** What handleIncomingCall does: tell native about a call JS now knows. */
  const seen = (mod: Awaited<ReturnType<typeof loadBridge>>, callId: string) =>
    mod.nativeCallBridge.ensureIncomingCallVisible({
      callId,
      callerName: 'test3823818',
      roomId: ROOM,
      hasVideo: false,
    });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('stops a finished call from auto-answering the redial', async () => {
    // The device owner's own report on the bench: «я не снимал трубку — она
    // сама снялась». A live answer writes the marker, nothing retired it, and
    // the next call from that room took handleIncomingCall's fast path —
    // answered with no ringer and no tap, opening the mic unattended.
    const listeners: NativeListeners = {};
    const mod = await loadBridge(noMarker(), noMarker(), { listeners });
    await mod.nativeCallBridge.wire(callService);
    listeners.callAnswered({ callId: MATRIX_CALL_ID, roomId: ROOM });

    await mod.retirePendingMarkers(MATRIX_CALL_ID, ROOM);

    await expect(mod.consumePendingAnswerCallId('1788970871478wZRHj3xutBX8VHfI', ROOM)).resolves.toBe(
      false,
    );
  });

  it('retires a marker the push path wrote under an event_id', async () => {
    // The case callId-only scoping could not reach, and the one that matters
    // most: a connection created from a push is keyed by the push's call_id,
    // which this homeserver fills with the event_id. finalizeCall carries the
    // Matrix callId, so the two never match and the room is the only shared
    // key. Push is the primary ringer surface, so without this the retire
    // would be inert exactly where the bug lives.
    const fromPush = markerAged(2_000);
    const mod = await loadBridge(noMarker(), fromPush);
    await mod.nativeCallBridge.wire(callService);
    fromPush.mockResolvedValue({ callId: null, roomId: null, atMs: 0 });
    // /sync delivers the invite; handleIncomingCall tells native about it.
    await seen(mod, MATRIX_CALL_ID);

    await mod.retirePendingMarkers(MATRIX_CALL_ID, ROOM);

    await expect(mod.consumePendingRejectCallId('a-later-call', ROOM)).resolves.toBe(false);
  });

  it('hands both keys to native so the marker native holds goes too', async () => {
    const retire = vi.fn().mockResolvedValue(undefined);
    const mod = await loadBridge(noMarker(), noMarker(), { retirePendingMarkers: retire });

    await mod.retirePendingMarkers(MATRIX_CALL_ID, ROOM);

    expect(retire).toHaveBeenCalledWith({ callId: MATRIX_CALL_ID, roomId: ROOM });
  });

  it('leaves a marker from another room alone', async () => {
    // Matching by room is what makes the push path work; it must still not
    // reach across rooms.
    const listeners: NativeListeners = {};
    const mod = await loadBridge(noMarker(), noMarker(), { listeners });
    await mod.nativeCallBridge.wire(callService);
    listeners.callAnswered({ callId: MATRIX_CALL_ID, roomId: ROOM });

    await mod.retirePendingMarkers('some-other-call', '!elsewhere:matrix.pocketnet.app');

    await expect(mod.consumePendingAnswerCallId(MATRIX_CALL_ID, ROOM)).resolves.toBe(true);
  });

  it('keeps a fresh marker that a newer call in the same room still needs', async () => {
    // Telecom displaces a still-ringing connection for a same-room re-invite,
    // so two calls in one room is a normal occurrence, not a contrivance.
    // Finishing the older one must not erase the newer one's marker — that
    // would strand the user's tap and reproduce the very symptom being fixed.
    // Time cannot decide this: the marker is written when the user taps, which
    // is often after JS already knew the call being finalized.
    const listeners: NativeListeners = {};
    const retire = vi.fn().mockResolvedValue(undefined);
    const mod = await loadBridge(noMarker(), noMarker(), { listeners, retirePendingMarkers: retire });
    await mod.nativeCallBridge.wire(callService);
    await seen(mod, 'the-older-call');
    await seen(mod, 'the-newer-call');
    listeners.callAnswered({ callId: 'the-newer-call', roomId: ROOM });

    await mod.retirePendingMarkers('the-older-call', ROOM);

    // Native is not even asked to widen the retire to the room.
    expect(retire).toHaveBeenCalledWith({ callId: 'the-older-call', roomId: undefined });
    await expect(mod.consumePendingAnswerCallId('the-newer-call', ROOM)).resolves.toBe(true);
  });

  it('does not let the push-announced twin pin the room', async () => {
    // The push handler reports the call under `call_id`, which this homeserver
    // fills with the event_id — an id no finalize can ever carry. Left in the
    // live-call map it would make the room read as busy for hours, and the
    // room match would never engage again on the very path that needs it.
    const retire = vi.fn().mockResolvedValue(undefined);
    const mod = await loadBridge(noMarker(), noMarker(), { retirePendingMarkers: retire });
    await mod.nativeCallBridge.reportIncomingCall({
      callId: PUSH_EVENT_ID,
      callerName: 'test3823818',
      roomId: ROOM,
      hasVideo: false,
    });
    await seen(mod, MATRIX_CALL_ID); // /sync delivers the same call, real id

    await mod.retirePendingMarkers(MATRIX_CALL_ID, ROOM);

    expect(retire).toHaveBeenCalledWith({ callId: MATRIX_CALL_ID, roomId: ROOM });
  });

  it('widens to the room again once the newer call is over too', async () => {
    const listeners: NativeListeners = {};
    const retire = vi.fn().mockResolvedValue(undefined);
    const mod = await loadBridge(noMarker(), noMarker(), { listeners, retirePendingMarkers: retire });
    await mod.nativeCallBridge.wire(callService);
    await seen(mod, 'the-older-call');
    await seen(mod, 'the-newer-call');

    await mod.retirePendingMarkers('the-older-call', ROOM);
    await mod.retirePendingMarkers('the-newer-call', ROOM);

    expect(retire).toHaveBeenLastCalledWith({ callId: 'the-newer-call', roomId: ROOM });
  });

  it('makes an answer consume wait for a retire still crossing the bridge', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retire = vi.fn(() => gate.then(() => void order.push('retire')));
    const mod = await loadBridge(markerAged(3_000), noMarker(), { retirePendingMarkers: retire });

    const retiring = mod.retirePendingMarkers(MATRIX_CALL_ID, ROOM);
    const consuming = mod
      .consumePendingAnswerCallId('a-later-call', ROOM)
      .then(() => void order.push('consume'));

    release();
    await Promise.all([retiring, consuming]);

    expect(order).toEqual(['retire', 'consume']);
  });

  it('makes a consume wait for a retire still crossing the bridge', async () => {
    // The native markers are read-and-clear, so a peek that overtook a retire
    // in flight would consume a marker already meant to be gone. Nothing in
    // Capacitor promises the two land in dispatch order, so the bridge orders
    // them itself.
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retire = vi.fn(() => gate.then(() => void order.push('retire')));
    const mod = await loadBridge(noMarker(), markerAged(3_000), { retirePendingMarkers: retire });

    const retiring = mod.retirePendingMarkers(MATRIX_CALL_ID, ROOM);
    const consuming = mod
      .consumePendingRejectCallId('a-later-call', ROOM)
      .then(() => void order.push('consume'));

    release();
    await Promise.all([retiring, consuming]);

    expect(order).toEqual(['retire', 'consume']);
  });
});

describe('consumePendingAnswerCallId', () => {
  it('answers the call the user accepted moments ago (cold start from push)', async () => {
    const { consumePendingAnswerCallId } = await loadBridge(markerAged(3_000), noMarker());

    await expect(consumePendingAnswerCallId(MATRIX_CALL_ID, ROOM)).resolves.toBe(true);
  });

  it('does not auto-answer a later call from the same room on a stale marker', async () => {
    const { consumePendingAnswerCallId } = await loadBridge(
      markerAged(5 * 60_000),
      noMarker(),
    );

    await expect(consumePendingAnswerCallId(MATRIX_CALL_ID, ROOM)).resolves.toBe(false);
  });

  it('does not pre-accept the next call from the same room on a fresh answer for another call', async () => {
    // The answer names a real Matrix callId, so a different id is a different
    // call, however young the marker and whatever room it shares.
    const { consumePendingAnswerCallId } = await loadBridge(
      markerForCall(MATRIX_CALL_ID, 6_000),
      noMarker(),
    );

    await expect(consumePendingAnswerCallId(NEXT_CALL_ID, ROOM)).resolves.toBe(false);
  });
});

describe("wire() replaying a queued answer", () => {
  // The Samsung repro, 2026-09-09. The user answered, talked, then swiped the
  // app away from Recents. That destroys the WebView but not the process, so
  // nothing ran finalizeCall and the marker `onAnswer` wrote stayed in native
  // statics. On the next app start wire() replayed it — 141 s later — and the
  // poll it armed answered an entirely different call from the same room:
  // no ringer, mic open, nobody had touched the phone.
  const freshService = () => ({
    answerCall: vi.fn(),
    rejectCall: vi.fn(),
    hangup: vi.fn(),
    currentCall: () => ({ callId: undefined }),
  });

  it("does not answer anything on a marker that outlived its invite", async () => {
    // Only setTimeout is faked: markerAged reads Date.now() to build the stamp,
    // and the freshness check reads it again — both must stay on the real clock.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const callService = freshService();
      const mod = await loadBridge(markerAged(141_000), noMarker());

      await mod.nativeCallBridge.wire(callService);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(callService.answerCall).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still answers on a fresh marker, so cold start from push keeps working", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const callService = freshService();
      const mod = await loadBridge(markerAged(3_000), noMarker());

      await mod.nativeCallBridge.wire(callService);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(callService.answerCall).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the replay right up to the TTL", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const callService = freshService();
      const mod = await loadBridge(
        markerAged(PENDING_MARKER_ROOM_TTL_MS - 5_000),
        noMarker(),
      );

      await mod.nativeCallBridge.wire(callService);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(callService.answerCall).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps seeding the marker, so an exact callId can still be consumed", async () => {
    // The replay is speculative and gets aged out; an exact callId match is not
    // ambiguous and stays valid whatever its age.
    const stale = vi.fn().mockResolvedValue({
      callId: MATRIX_CALL_ID,
      roomId: ROOM,
      atMs: Date.now() - 10 * 60_000,
    });
    const mod = await loadBridge(stale, noMarker());
    await mod.nativeCallBridge.wire({
      answerCall: vi.fn(),
      rejectCall: vi.fn(),
      hangup: vi.fn(),
      currentCall: () => ({ callId: undefined }),
    });
    stale.mockResolvedValue({ callId: null, roomId: null, atMs: 0 });

    await expect(mod.consumePendingAnswerCallId(MATRIX_CALL_ID, ROOM)).resolves.toBe(true);
  });

  it("does not hand a queued answer to the next call from the same room", async () => {
    // orphan3a on the Samsung, 2026-09-13. Call A, swiped away while ringing,
    // was answered from AirPods with JS dead. On the next start wire() seeded
    // that answer, and call B from the same room arrived six seconds later:
    // handleIncomingCall consumed A's marker for B by room, and B connected
    // with nobody touching the phone. The wait itself was already bound to A.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const callService = freshService();
      const answeredA = markerForCall(MATRIX_CALL_ID, 6_000);
      const mod = await loadBridge(answeredA, noMarker(), {
        matrixCall: { callId: NEXT_CALL_ID, roomId: ROOM },
      });
      await mod.nativeCallBridge.wire(callService);
      // getPendingAnswer is read-and-clear: wire() has already taken it.
      answeredA.mockResolvedValue({ callId: null, roomId: null, atMs: 0 });

      const preAccepted = await mod.consumePendingAnswerCallId(NEXT_CALL_ID, ROOM);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(preAccepted).toBe(false);
      expect(callService.answerCall).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the queued-answer waiter", () => {
  const OTHER_CALL_ID = "1788984290557dSfOceinVzLEuz9Z";
  const freshService = () => ({
    answerCall: vi.fn(),
    rejectCall: vi.fn(),
    hangup: vi.fn(),
    currentCall: () => ({ callId: undefined }),
  });

  it("does not adopt a different call from the same room", async () => {
    // A marker written by CallConnection.onAnswer carries the real Matrix
    // callId, so the room fallback buys nothing and can only mis-fire.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const callService = freshService();
      const listeners: NativeListeners = {};
      const mod = await loadBridge(noMarker(), noMarker(), {
        listeners,
        matrixCall: { callId: OTHER_CALL_ID, roomId: ROOM },
      });
      await mod.nativeCallBridge.wire(callService);

      listeners.callAnswered({ callId: MATRIX_CALL_ID, roomId: ROOM });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(callService.answerCall).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the room fallback for a push id, which can never match by callId", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const callService = freshService();
      const listeners: NativeListeners = {};
      const mod = await loadBridge(noMarker(), noMarker(), {
        listeners,
        matrixCall: { callId: OTHER_CALL_ID, roomId: ROOM },
      });
      await mod.nativeCallBridge.wire(callService);

      listeners.callAnswered({ callId: PUSH_EVENT_ID, roomId: ROOM });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(callService.answerCall).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a newer wait supersede an older one", async () => {
    // Nothing used to stop a wait: no handle was kept and neither answering nor
    // hanging up cancelled it, so one armed for call A polled for a full 30 s
    // and could still fire on call B.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const callService = freshService();
      const listeners: NativeListeners = {};
      const mod = await loadBridge(noMarker(), noMarker(), {
        listeners,
        matrixCall: { callId: PUSH_EVENT_ID, roomId: ROOM },
      });
      await mod.nativeCallBridge.wire(callService);

      listeners.callAnswered({ callId: PUSH_EVENT_ID, roomId: ROOM });
      listeners.callAnswered({ callId: PUSH_EVENT_ID, roomId: ROOM });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(callService.answerCall).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the room fallback inside a running wait", () => {
  const OTHER_CALL_ID = "1788984290557dSfOceinVzLEuz9Z";

  // The wait runs 30 s and the marker may already be nearly a minute old when
  // it arms, so checking freshness only at arm time still leaves a window in
  // which a redial into the same room gets adopted. Bounding the fallback by
  // the marker's own age closes it at one invite lifetime from the user's tap.
  it("stops matching by room once the marker ages out mid-poll", async () => {
    // Everything stays inside RECOVERY_GRACE_MS (2 s): past it the tick enters
    // the invite-recovery pass, which needs the Matrix client this harness does
    // not mock, and the poll would stall there instead of proving anything.
    const nearlyStale = markerAged(PENDING_MARKER_ROOM_TTL_MS - 500);
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const callService = { answerCall: vi.fn(), rejectCall: vi.fn(), hangup: vi.fn(), currentCall: () => ({ callId: undefined }) };
      let live: { callId: string; roomId: string } | null = null;
      const mod = await loadBridge(nearlyStale, noMarker(), { matrixCall: () => live });

      await mod.nativeCallBridge.wire(callService);
      // Fresh enough to arm, but nothing in the room yet.
      await vi.advanceTimersByTimeAsync(400);
      expect(callService.answerCall).not.toHaveBeenCalled();

      // Past the marker's lifetime now. A call showing up in that room is a
      // different call, and must not be adopted.
      await vi.advanceTimersByTimeAsync(400);
      live = { callId: OTHER_CALL_ID, roomId: ROOM };
      await vi.advanceTimersByTimeAsync(900);

      expect(callService.answerCall).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still adopts one while the marker is fresh, which is the cold-start case", async () => {
    const fresh = markerAged(3_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const callService = { answerCall: vi.fn(), rejectCall: vi.fn(), hangup: vi.fn(), currentCall: () => ({ callId: undefined }) };
      let live: { callId: string; roomId: string } | null = null;
      const mod = await loadBridge(fresh, noMarker(), { matrixCall: () => live });

      await mod.nativeCallBridge.wire(callService);
      await vi.advanceTimersByTimeAsync(400);
      live = { callId: OTHER_CALL_ID, roomId: ROOM };
      await vi.advanceTimersByTimeAsync(900);

      expect(callService.answerCall).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("retiring an answer marker stops the wait it was driving", () => {
  const OTHER_CALL_ID = "1788984290557dSfOceinVzLEuz9Z";

  // The wait polls for 30 s and a push-keyed marker keeps the room fallback
  // open the whole time, so a wait whose decision has already been acted on can
  // still adopt the next invite in that room. finalizeCall retires the markers
  // as its step 0; the wait has to die with them.
  it("does not adopt a later call in the room after the marker is retired", async () => {
    const fresh = markerAged(3_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const callService = { answerCall: vi.fn(), rejectCall: vi.fn(), hangup: vi.fn(), currentCall: () => ({ callId: undefined }) };
      let live: { callId: string; roomId: string } | null = null;
      const mod = await loadBridge(fresh, noMarker(), { matrixCall: () => live });

      await mod.nativeCallBridge.wire(callService);
      await vi.advanceTimersByTimeAsync(400);
      expect(callService.answerCall).not.toHaveBeenCalled();

      await mod.retirePendingMarkers(PUSH_EVENT_ID, ROOM);

      live = { callId: OTHER_CALL_ID, roomId: ROOM };
      await vi.advanceTimersByTimeAsync(900);

      expect(callService.answerCall).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // The path that actually runs for most calls. handleIncomingCall consumes the
  // marker as soon as the invite arrives, which nulls the slot — so the retire
  // in finalizeCall finds nothing to mark spent and cannot cancel anything. The
  // consume has to do it, or the wait outlives the decision it was replaying.
  it("stops the wait when the marker is consumed rather than retired", async () => {
    const fresh = markerAged(3_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const callService = { answerCall: vi.fn(), rejectCall: vi.fn(), hangup: vi.fn(), currentCall: () => ({ callId: undefined }) };
      let live: { callId: string; roomId: string } | null = null;
      const mod = await loadBridge(fresh, noMarker(), { matrixCall: () => live });

      await mod.nativeCallBridge.wire(callService);
      await vi.advanceTimersByTimeAsync(400);
      expect(callService.answerCall).not.toHaveBeenCalled();

      // handleIncomingCall's consume: matches the push-keyed marker by room and
      // answers that call itself.
      expect(await mod.consumePendingAnswerCallId(MATRIX_CALL_ID, ROOM)).toBe(true);

      // A different call turns up in the same room. The wait must be gone.
      live = { callId: OTHER_CALL_ID, roomId: ROOM };
      await vi.advanceTimersByTimeAsync(900);

      expect(callService.answerCall).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
