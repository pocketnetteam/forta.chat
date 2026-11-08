// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  mockEnsureIncomingCallVisible,
  mockReportCallEnded,
  mockSetActiveCall,
  mockSetMatrixCall,
  mockCallStore,
  mockAnswer,
  mockReject,
  mockOn,
  mockOff,
  mockLoadUsersBatch,
  mockGetUser,
  resetCallServiceHarness,
} from './call-service.harness';

describe('call-service: an incoming invite', () => {
  beforeEach(resetCallServiceHarness);

  describe('incoming calls switched off (#1388)', () => {
    it('neither rings nor rejects, so Bastyon and other devices keep ringing', async () => {
      const { __resetIncomingCallDedupForTests } = await import('./incoming-call-dedup');
      const { useCallService } = await import('./call-service');
      __resetIncomingCallDedupForTests();
      window.localStorage.setItem('forta-chat:incoming_calls_enabled', 'false');
      mockSetMatrixCall.mockClear();
      const reject = vi.fn();
      const on = vi.fn();

      try {
        await useCallService().handleIncomingCall({
          callId: 'calls-off-a',
          roomId: '!room:matrix.org',
          type: 'voice',
          on,
          off: vi.fn(),
          reject,
          getOpponentMember: vi.fn(() => ({ userId: '@peer:matrix.org' })),
        } as never);
      } finally {
        window.localStorage.removeItem('forta-chat:incoming_calls_enabled');
      }

      expect(mockSetMatrixCall).not.toHaveBeenCalled();
      expect(on).not.toHaveBeenCalled();
      expect(reject).not.toHaveBeenCalled();
    });

    // Review 2026-10-08: the C01 setup reservation answered the second invite
    // busy while the first was still being ignored, so the caller heard busy
    // and the account's other devices stopped ringing.
    it('ignores a second invite that arrives while the first is being ignored', async () => {
      const { __resetIncomingCallDedupForTests } = await import('./incoming-call-dedup');
      const { useCallService } = await import('./call-service');
      __resetIncomingCallDedupForTests();
      window.localStorage.setItem('forta-chat:incoming_calls_enabled', 'false');
      mockSetMatrixCall.mockClear();
      const invite = (callId: string) => ({
        callId,
        roomId: '!room:matrix.org',
        type: 'voice',
        on: vi.fn(),
        off: vi.fn(),
        reject: vi.fn(),
        getOpponentMember: vi.fn(() => ({ userId: '@peer:matrix.org' })),
      });
      const first = invite('calls-off-first');
      const second = invite('calls-off-second');

      try {
        await Promise.all([
          useCallService().handleIncomingCall(first as never),
          useCallService().handleIncomingCall(second as never),
        ]);
      } finally {
        window.localStorage.removeItem('forta-chat:incoming_calls_enabled');
      }

      expect(first.reject).not.toHaveBeenCalled();
      expect(second.reject).not.toHaveBeenCalled();
      expect(mockSetMatrixCall).not.toHaveBeenCalled();
    });
  });

  describe('incoming-call dedup window (#644)', () => {
    function incoming(callId: string) {
      return {
        callId,
        roomId: '!room:matrix.org',
        type: 'voice',
        on: mockOn,
        off: mockOff,
        answer: mockAnswer,
        reject: mockReject,
        localUsermediaStream: null,
        localScreensharingStream: null,
        remoteUsermediaStream: null,
        remoteScreensharingStream: null,
        remoteUsermediaFeed: null,
        getOpponentMember: vi.fn(() => ({ userId: '@peer:matrix.org' })),
      };
    }

    // Regression: a call starting inside the previous call's clear window
    // cancelled that clear — the only reset of its mute, minimized and timer
    // fields — so the new call began muted or with its window hidden.
    it('resets the ended call\'s state when the next call takes the slot', async () => {
      const { useCallService } = await import('./call-service');
      const clearCall = mockCallStore.clearCall as Mock;
      clearCall.mockClear();
      mockCallStore.hasLiveCall = false;
      mockCallStore.matrixCall = incoming('ended-call');
      await useCallService().handleIncomingCall(incoming('next-call') as never);
      expect(clearCall).toHaveBeenCalledTimes(1);
      expect(clearCall.mock.invocationCallOrder[0]).toBeLessThan(mockSetMatrixCall.mock.invocationCallOrder.at(-1)!);
    });

    // Regression: reject() throws once the SDK ended the invite; the throw
    // escaped as an unhandled rejection and kept the dedup slot taken.
    it('releases the dedup slot when rejecting a busy invite throws', async () => {
      const { isIncomingCallSeen, __resetIncomingCallDedupForTests } =
        await import('./incoming-call-dedup');
      const { useCallService } = await import('./call-service');
      __resetIncomingCallDedupForTests();
      mockCallStore.hasLiveCall = true;
      const call = { ...incoming('busy-throws'), reject: vi.fn(() => { throw new Error("Call must be in 'ringing' state to reject!"); }) };
      try {
        await expect(useCallService().handleIncomingCall(call as never)).resolves.toBeUndefined();
      } finally {
        mockCallStore.hasLiveCall = false;
      }
      expect(isIncomingCallSeen('busy-throws')).toBe(false);
    });

    // C01 (calls review 2026-10-04): two invites raced through the setup
    // awaits, both found the slot empty and the second overwrote the first.
    it('answers a second invite busy while the first is still being set up', async () => {
      const { useCallService } = await import('./call-service');
      mockCallStore.hasLiveCall = false;
      mockCallStore.matrixCall = null;
      let release!: () => void;
      mockGetUser.mockReturnValueOnce(undefined);
      mockLoadUsersBatch.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
      const first = { ...incoming('first-call'), reject: vi.fn() };
      const second = { ...incoming('second-call'), reject: vi.fn() };
      // The slot as the real store keeps it: the first call takes it.
      mockSetMatrixCall.mockImplementation((c: { state?: string } | null) => {
        mockCallStore.matrixCall = c as never;
        mockCallStore.hasLiveCall = !!c && c.state !== 'ended';
      });
      try {
        const p1 = useCallService().handleIncomingCall(first as never);
        await new Promise((r) => setTimeout(r, 0));
        const p2 = useCallService().handleIncomingCall(second as never);
        await new Promise((r) => setTimeout(r, 0));
        release();
        await Promise.all([p1, p2]);
      } finally {
        mockSetMatrixCall.mockImplementation(() => undefined);
        mockCallStore.hasLiveCall = false;
        mockCallStore.matrixCall = null;
      }
      expect(second.reject).toHaveBeenCalled();
      expect(first.reject).not.toHaveBeenCalled();
      const slotted = mockSetMatrixCall.mock.calls.map((c) => (c[0] as { callId?: string } | null)?.callId).filter(Boolean);
      expect(slotted).toEqual(['first-call']);
    });

    // Review 2026-10-08: the reservation answered the second invite busy even
    // when the first one's setup came to nothing (expired, declined in the
    // native ringer, owned by another tab) and the user was free.
    it('rings a second invite once the first one\'s setup came to nothing', async () => {
      const { useCallService } = await import('./call-service');
      mockCallStore.hasLiveCall = false;
      mockCallStore.matrixCall = null;
      let release!: () => void;
      mockGetUser.mockReturnValueOnce(undefined);
      mockLoadUsersBatch.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
      // The SDK ends the first invite while its setup waits (an expired invite).
      const first = { ...incoming('expired-first'), reject: vi.fn(), state: 'ended' };
      const second = { ...incoming('fresh-second'), reject: vi.fn(), state: 'ringing' };
      mockSetMatrixCall.mockImplementation((c: { state?: string } | null) => {
        mockCallStore.matrixCall = c as never;
        mockCallStore.hasLiveCall = !!c && c.state !== 'ended';
      });
      try {
        const p1 = useCallService().handleIncomingCall(first as never);
        await new Promise((r) => setTimeout(r, 0));
        const p2 = useCallService().handleIncomingCall(second as never);
        await new Promise((r) => setTimeout(r, 0));
        release();
        await Promise.all([p1, p2]);
      } finally {
        mockSetMatrixCall.mockImplementation(() => undefined);
        mockCallStore.hasLiveCall = false;
        mockCallStore.matrixCall = null;
      }
      expect(second.reject).not.toHaveBeenCalled();
      const slotted = mockSetMatrixCall.mock.calls.map((c) => (c[0] as { callId?: string } | null)?.callId);
      expect(slotted).toContain('fresh-second');
    });

    it('answers an invite busy when another call took the slot during its setup', async () => {
      const { useCallService } = await import('./call-service');
      mockCallStore.hasLiveCall = false;
      mockCallStore.matrixCall = null;
      let release!: () => void;
      mockGetUser.mockReturnValueOnce(undefined);
      mockLoadUsersBatch.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
      const invite = { ...incoming('late-invite'), reject: vi.fn() };
      const p = useCallService().handleIncomingCall(invite as never);
      await new Promise((r) => setTimeout(r, 0));
      mockCallStore.hasLiveCall = true; // a dial or another call won the slot meanwhile
      mockCallStore.matrixCall = incoming('slot-owner');
      release();
      try {
        await p;
      } finally {
        mockCallStore.hasLiveCall = false;
      }
      expect(invite.reject).toHaveBeenCalled();
      const slotted = mockSetMatrixCall.mock.calls.map((c) => (c[0] as { callId?: string } | null)?.callId);
      expect(slotted).not.toContain('late-invite');
    });

    it('does not reset a live call in the slot', async () => {
      const { useCallService } = await import('./call-service');
      const clearCall = mockCallStore.clearCall as Mock;
      clearCall.mockClear();
      const call = incoming('same-call');
      mockCallStore.matrixCall = call;
      await useCallService().handleIncomingCall(call as never);
      expect(clearCall).not.toHaveBeenCalled();
    });

    it('keeps the call marked as seen once its handlers are wired', async () => {
      const { isIncomingCallSeen, __resetIncomingCallDedupForTests } =
        await import('./incoming-call-dedup');
      const { useCallService } = await import('./call-service');
      __resetIncomingCallDedupForTests();
      const service = useCallService();

      const call = incoming('dedup-call-a');
      mockCallStore.matrixCall = call;
      await service.handleIncomingCall(call as never);

      // wireCallEvents opens by unwiring the very call it is about to wire.
      // That teardown used to clear the mark set moments earlier, so the
      // window never survived the same tick and a repeat invite rang twice.
      expect(isIncomingCallSeen('dedup-call-a')).toBe(true);
    });

    it('releases the slot of the call it unwires, not of the new one', async () => {
      const { isIncomingCallSeen, __resetIncomingCallDedupForTests } =
        await import('./incoming-call-dedup');
      const { useCallService } = await import('./call-service');
      __resetIncomingCallDedupForTests();
      const service = useCallService();

      const first = incoming('dedup-call-a');
      mockCallStore.matrixCall = first;
      await service.handleIncomingCall(first as never);

      const second = incoming('dedup-call-b');
      mockCallStore.matrixCall = second;
      await service.handleIncomingCall(second as never);

      // Wiring the second call tears down the first: the first call's slot is
      // the one that must be freed, so a genuine re-invite for it later still
      // rings, while the call now on screen stays deduped.
      expect(isIncomingCallSeen('dedup-call-a')).toBe(false);
      expect(isIncomingCallSeen('dedup-call-b')).toBe(true);
    });
  });

  describe('detaching handlers from the right call object', () => {
    // MatrixCall extends TypedEventEmitter, so listener state lives on the
    // instance. Teardown used to call `off` on whatever call it was handed,
    // with the handlers of whichever call was wired last — a silent no-op
    // when those differ, leaving the first call's handlers alive. Those
    // handlers are not callId-scoped on the native side: when the abandoned
    // call finally timed out, its onState ran finalizeCall and tore down the
    // audio, UI and peer connections of the call actually in progress.

    function callWithOwnSpies(callId: string) {
      const on = vi.fn();
      const off = vi.fn();
      return {
        spy: { on, off },
        call: {
          callId,
          roomId: '!room:matrix.org',
          type: 'voice',
          state: 'ringing',
          on,
          off,
          answer: mockAnswer,
          reject: mockReject,
          getOpponentMember: vi.fn(() => ({ userId: '@peer:matrix.org' })),
        },
      };
    }

    it('detaches from the call the handlers were attached to', async () => {
      const { useCallService } = await import('./call-service');
      const { __resetIncomingCallDedupForTests } = await import('./incoming-call-dedup');
      __resetIncomingCallDedupForTests();
      const service = useCallService();

      const a = callWithOwnSpies('detach-a');
      const b = callWithOwnSpies('detach-b');

      mockCallStore.matrixCall = a.call;
      await service.handleIncomingCall(a.call as never);
      const offCountAfterFirst = a.spy.off.mock.calls.length;

      // Wiring b tears down a. Every off() must land on a — b has nothing
      // attached yet, so an off() there would be the silent no-op that leaves
      // a's handlers alive.
      mockCallStore.matrixCall = b.call;
      await service.handleIncomingCall(b.call as never);

      expect(a.spy.off.mock.calls.length).toBeGreaterThan(offCountAfterFirst);
      expect(b.spy.off).not.toHaveBeenCalled();
    });
  });

  describe('expired invite delivered late (#958 / #928)', () => {
    // When FCM delivery degrades the homeserver retains the invite and
    // flushes it on the next /sync, minutes later. The SDK arms its expiry
    // timer with `lifetime - localAge` — negative for a retained invite — so
    // it ends the call on the tick right after Call.incoming, while our
    // handler is still awaiting profile lookups. Ringing after that point is
    // the "a call came in seven minutes later and there was no call" report.

    // Distinct callId per test: the module-scope dedup window survives between
    // tests, so a shared id makes one test's outcome depend on whether the
    // previous one released the slot.
    function staleIncoming(state: string, callId: string) {
      return {
        callId,
        roomId: '!room:matrix.org',
        type: 'voice',
        state,
        on: mockOn,
        off: mockOff,
        answer: mockAnswer,
        reject: mockReject,
        getOpponentMember: vi.fn(() => ({ userId: '@peer:matrix.org' })),
      };
    }

    it('does not ring for a call the SDK already ended', async () => {
      const { useCallService } = await import('./call-service');
      await useCallService().handleIncomingCall(
        staleIncoming('ended', 'stale-invite-a') as never,
      );

      expect(mockEnsureIncomingCallVisible).not.toHaveBeenCalled();
      expect(mockSetActiveCall).not.toHaveBeenCalled();
    });

    it('tells native the call is over so the ringer stops', async () => {
      // FCM usually wins the race that delivers a retained invite, so the
      // native ringer is already up by the time this handler runs. Only
      // finalizeCall releases the Telecom connection and dismisses it —
      // nulling the Pinia slot is invisible to native.
      const { useCallService } = await import('./call-service');

      await useCallService().handleIncomingCall(
        staleIncoming('ended', 'stale-invite-d') as never,
      );
      await vi.waitFor(() =>
        expect(mockReportCallEnded).toHaveBeenCalledWith('stale-invite-d'),
      );
    });

    it('vacates the call slot it had already taken', async () => {
      // setMatrixCall runs before this check (rejectCall/answerCall need the
      // object), so bailing out has to hand the slot back or `hasLiveCall`
      // would report a live call that nothing can ever end.
      const { useCallService } = await import('./call-service');
      await useCallService().handleIncomingCall(
        staleIncoming('ended', 'stale-invite-b') as never,
      );

      expect(mockSetMatrixCall).toHaveBeenLastCalledWith(null);
    });

    // Regression: the push-accepted branch skipped the expiry check, set an
    // "incoming" CallInfo and answered; answerCall returned on the ended call
    // and nothing ever cleared it — isInCall stuck, every later call busy.
    it('drops an expired invite the user already accepted on the push ringer', async () => {
      const { consumePendingAnswerCallId } = await import('@/shared/lib/native-calls');
      vi.mocked(consumePendingAnswerCallId).mockResolvedValueOnce(true);
      const { useCallService } = await import('./call-service');
      await useCallService().handleIncomingCall(
        staleIncoming('ended', 'stale-invite-e') as never,
      );

      expect(mockSetActiveCall).not.toHaveBeenCalled();
      expect(mockAnswer).not.toHaveBeenCalled();
      expect(mockSetMatrixCall).toHaveBeenLastCalledWith(null);
      await vi.waitFor(() =>
        expect(mockReportCallEnded).toHaveBeenCalledWith('stale-invite-e'),
      );
    });

    it('still rings a call the SDK is holding in ringing state', async () => {
      const { useCallService } = await import('./call-service');
      await useCallService().handleIncomingCall(
        staleIncoming('ringing', 'stale-invite-c') as never,
      );

      expect(mockEnsureIncomingCallVisible).toHaveBeenCalled();
    });
  });

  // Review 2026-10-08 (TS3): a native marker read that never answered held
  // the incoming setup, and every later invite waited behind it for good.
  describe('a native marker read that never answers', () => {
    it('does not hold the incoming queue', async () => {
      const { consumePendingRejectCallId } = await import('@/shared/lib/native-calls');
      const invite = (callId: string) => ({
        callId,
        roomId: '!room:matrix.org',
        type: 'voice',
        state: 'ringing',
        on: mockOn,
        off: mockOff,
        answer: mockAnswer,
        reject: vi.fn(),
        getOpponentMember: vi.fn(() => ({ userId: '@peer:matrix.org' })),
      });
      vi.useFakeTimers();
      try {
        vi.mocked(consumePendingRejectCallId).mockImplementationOnce(() => new Promise<boolean>(() => {}));
        const { useCallService } = await import('./call-service');
        let settled = false;
        void Promise.all([
          useCallService().handleIncomingCall(invite('stuck-read') as never),
          useCallService().handleIncomingCall(invite('waiting-behind') as never),
        ]).then(() => { settled = true; });

        await vi.advanceTimersByTimeAsync(10_000);

        expect(settled).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Review 2026-10-08 (TS2): the invite expired while its pending-answer read
  // ran, and a dial took the slot meanwhile. Dropping the expired invite used
  // to unwire and null the slot globally — that dial's.
  describe('an invite dropped after its awaits', () => {
    it('leaves a dial that took the slot meanwhile', async () => {
      const { consumePendingAnswerCallId } = await import('@/shared/lib/native-calls');
      const invite = {
        callId: 'expired-invite',
        roomId: '!room:matrix.org',
        type: 'voice',
        state: 'ringing',
        on: mockOn,
        off: mockOff,
        answer: mockAnswer,
        reject: mockReject,
        getOpponentMember: vi.fn(() => ({ userId: '@peer:matrix.org' })),
      };
      const dial = { callId: 'dial', state: 'invite_sent', callHasEnded: () => false };
      vi.mocked(consumePendingAnswerCallId).mockImplementationOnce(async () => {
        invite.state = 'ended';
        mockCallStore.matrixCall = dial;
        return true;
      });

      const { useCallService } = await import('./call-service');
      await useCallService().handleIncomingCall(invite as never);

      expect(mockSetMatrixCall).not.toHaveBeenCalledWith(null);
      expect(mockCallStore.matrixCall).toBe(dial);
    });
  });
});
