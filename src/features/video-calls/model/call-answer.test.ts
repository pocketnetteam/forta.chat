// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mockNativeWebRTCMethods,
  mockStartAudioRouting,
  mockStopAudioRouting,
  mockReportCallEnded,
  MockPermissionDeniedError,
  mockEnsureCallPermissions,
  mockUpdateStatus,
  mockScheduleClearCall,
  mockSetActiveCall,
  mockCallStore,
  mockAnswer,
  mockReject,
  mockOn,
  mockOff,
  matrixState,
  mockHoldPageAwake,
  resetCallServiceHarness,
} from './call-service.harness';

describe('call-service: answering', () => {
  beforeEach(resetCallServiceHarness);

  describe('answerCall', () => {
    function seedIncomingCall(type: 'voice' | 'video' = 'voice') {
      mockCallStore.matrixCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type,
        on: mockOn,
        off: mockOff,
        answer: mockAnswer,
        reject: mockReject,
        localUsermediaStream: null,
        localScreensharingStream: null,
        remoteUsermediaStream: null,
        remoteScreensharingStream: null,
        remoteUsermediaFeed: null,
      };
      mockCallStore.activeCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type,
        direction: 'incoming',
        peerName: 'Peer',
        status: 'incoming',
      };
    }

    it('calls ensureCallPermissions with isVideo=false before answering voice', async () => {
      seedIncomingCall('voice');

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();

      expect(mockEnsureCallPermissions).toHaveBeenCalledWith(false);
    });

    it('calls ensureCallPermissions with isVideo=true before answering video', async () => {
      seedIncomingCall('video');

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();

      expect(mockEnsureCallPermissions).toHaveBeenCalledWith(true);
    });

    it('sets CallStatus.failed when microphone denied on answer and does NOT call SDK answer', async () => {
      seedIncomingCall('voice');
      mockEnsureCallPermissions.mockRejectedValueOnce(
        new MockPermissionDeniedError('microphone'),
      );

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();

      expect(mockUpdateStatus).toHaveBeenCalledWith('failed');
      expect(mockScheduleClearCall).toHaveBeenCalled();
      expect(mockAnswer).not.toHaveBeenCalled();
    });

    it('rejects the incoming matrixCall when permission denied so caller stops ringing', async () => {
      seedIncomingCall('voice');
      mockEnsureCallPermissions.mockRejectedValueOnce(
        new MockPermissionDeniedError('microphone'),
      );

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();

      expect(mockReject).toHaveBeenCalled();
    });

    it('sets CallStatus.failed when camera denied during video answer', async () => {
      seedIncomingCall('video');
      mockEnsureCallPermissions.mockRejectedValueOnce(
        new MockPermissionDeniedError('camera'),
      );

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();

      expect(mockUpdateStatus).toHaveBeenCalledWith('failed');
      expect(mockAnswer).not.toHaveBeenCalled();
    });

    // WEE-45 / forta-bugs#724 — accept-button double-tap regression.
    // The pre-existing status-based guard (`if currentStatus === connecting
    // || connected return`) only protects AFTER `updateStatus('connecting')`
    // has run. Between the entry check and `await ensureCallPermissions`
    // resolving, status stays `incoming` for several hundred ms — long
    // enough for an impatient user (or a flaky Android touchscreen) to
    // double-tap. Without the sync re-entry lock, both invocations pass
    // the guard and both eventually call `matrixCall.answer()`, wedging
    // the SDK state machine. This test asserts the sync lock holds even
    // when both calls are dispatched before the permission promise settles.
    it('does not invoke SDK answer twice when accept button is double-tapped (forta-bugs#724)', async () => {
      seedIncomingCall('voice');
      // Hold the permission preflight pending so the second invocation
      // races the first while status is still `incoming`. This mirrors
      // the real-device timing where the OS permission dialog (or the
      // probeAudioAvailability roundtrip) opens a ~200ms window.
      let releasePermissions: () => void = () => {};
      mockEnsureCallPermissions.mockImplementationOnce(
        () => new Promise<void>((resolve) => { releasePermissions = resolve; }),
      );

      const { useCallService } = await import('./call-service');
      const service = useCallService();

      const firstAnswer = service.answerCall();
      const secondAnswer = service.answerCall();
      releasePermissions();
      await Promise.all([firstAnswer, secondAnswer]);

      expect(mockAnswer).toHaveBeenCalledTimes(1);
    });

    // Recoverability check: once a previous answerCall has completed (success
    // or error), the lock must reset so a *fresh* incoming call can still
    // be answered. The lock is released as soon as status flips to
    // `connecting` so a stuck `call.answer()` cannot permanently jam future
    // answers (existing watchdog at H3 covers stuck-connecting recovery).
    it('releases the re-entry lock after a previous answer completes', async () => {
      seedIncomingCall('voice');

      const { useCallService } = await import('./call-service');
      const service = useCallService();

      await service.answerCall();
      expect(mockAnswer).toHaveBeenCalledTimes(1);

      // Simulate a second incoming call after the first one resolved.
      // Status returns to `incoming` (fresh call) and matrixCall is
      // replaced. The second answer must go through, not be silently
      // dropped by a sticky lock.
      mockAnswer.mockClear();
      seedIncomingCall('voice');
      await service.answerCall();
      expect(mockAnswer).toHaveBeenCalledTimes(1);
    });

    // Recoverability check #2: when permission is denied on the first
    // answer, the user might grant permission in Settings and try again
    // on a fresh incoming call. The lock must NOT remain stuck just
    // because the permission preflight rejected.
    it('releases the re-entry lock after a permission-denied answer', async () => {
      seedIncomingCall('voice');
      mockEnsureCallPermissions.mockRejectedValueOnce(
        new MockPermissionDeniedError('microphone'),
      );

      const { useCallService } = await import('./call-service');
      const service = useCallService();

      await service.answerCall();
      expect(mockAnswer).not.toHaveBeenCalled();

      // Permission granted on retry, fresh incoming call comes in.
      seedIncomingCall('voice');
      await service.answerCall();
      expect(mockAnswer).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // H2: call.answer() must signal the peer BEFORE any UX transitions. When
  // launchCallUI blocks (some OEMs take 300-800ms to bring the Activity up
  // from background), letting it run before call.answer() means the caller
  // sees no answer in time and sends m.call.hangup — which manifests as
  // "his app drops the call" (#310) from the answerer's perspective.
  // -------------------------------------------------------------------------
  describe('answerCall SDP ordering (H2)', () => {
    function seedIncomingCall(type: 'voice' | 'video' = 'voice') {
      mockCallStore.matrixCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type,
        on: mockOn,
        off: mockOff,
        answer: mockAnswer,
        reject: mockReject,
        localUsermediaStream: null,
        localScreensharingStream: null,
        remoteUsermediaStream: null,
        remoteScreensharingStream: null,
        remoteUsermediaFeed: null,
      };
      mockCallStore.activeCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type,
        direction: 'incoming',
        peerName: 'Peer',
        status: 'incoming',
      };
    }

    it('calls call.answer BEFORE NativeWebRTC.launchCallUI', async () => {
      seedIncomingCall('voice');

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();

      expect(mockAnswer).toHaveBeenCalledOnce();
      expect(mockNativeWebRTCMethods.launchCallUI).toHaveBeenCalled();
      const answerOrder = mockAnswer.mock.invocationCallOrder[0];
      const launchOrder = mockNativeWebRTCMethods.launchCallUI.mock.invocationCallOrder[0];
      expect(answerOrder).toBeLessThan(launchOrder);
    });

    it('calls call.answer BEFORE startAudioRouting', async () => {
      seedIncomingCall('voice');

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();

      expect(mockAnswer).toHaveBeenCalledOnce();
      expect(mockStartAudioRouting).toHaveBeenCalled();
      const answerOrder = mockAnswer.mock.invocationCallOrder[0];
      const routingOrder = mockStartAudioRouting.mock.invocationCallOrder[0];
      expect(answerOrder).toBeLessThan(routingOrder);
    });

    // Regression: a caller who hung up while the answer was in flight left a
    // native call screen and audio routing up for a call that was over.
    it('does not answer a call that ended during the permission prompt', async () => {
      seedIncomingCall('voice');
      (mockCallStore.matrixCall as Record<string, unknown>).callHasEnded = () => true;

      const { useCallService } = await import('./call-service');
      await useCallService().answerCall();

      expect(mockAnswer).not.toHaveBeenCalled();
      expect(mockStartAudioRouting).not.toHaveBeenCalled();
    });

    it('brings up no call screen or routing for a call that ended while answering', async () => {
      seedIncomingCall('voice');
      let ended = false;
      (mockCallStore.matrixCall as Record<string, unknown>).callHasEnded = () => ended;
      mockAnswer.mockImplementationOnce(async () => {
        ended = true;
      });

      const { useCallService } = await import('./call-service');
      await useCallService().answerCall();

      expect(mockAnswer).toHaveBeenCalledOnce();
      expect(mockStartAudioRouting).not.toHaveBeenCalled();
      expect(mockNativeWebRTCMethods.launchCallUI).not.toHaveBeenCalled();
    });

    // C03 (calls review 2026-10-04): the SDK returns from answer() without
    // adopting the stream when the call ended during getUserMedia, so
    // releaseLocalMedia(call) saw nothing and the mic stayed open.
    // Review 2026-10-08 (TS1): answer() threw after the call ended and the
    // next call already holds the slot; failing and clearing it was not this
    // call's to do.
    it('leaves the next call in the slot alone when answering fails after the hangup', async () => {
      seedIncomingCall('voice');
      let ended = false;
      (mockCallStore.matrixCall as Record<string, unknown>).callHasEnded = () => ended;
      const next = { callId: 'next-call', state: 'ringing', callHasEnded: () => false };
      mockAnswer.mockImplementationOnce(async () => {
        ended = true;
        mockCallStore.matrixCall = next;
        throw new Error('answer failed after the hangup');
      });
      mockUpdateStatus.mockClear();
      mockScheduleClearCall.mockClear();

      const { useCallService } = await import('./call-service');
      await useCallService().answerCall();

      expect(mockUpdateStatus).not.toHaveBeenCalledWith('failed');
      expect(mockScheduleClearCall).not.toHaveBeenCalled();
      expect(mockCallStore.matrixCall).toBe(next);
    });

    it('stops the stream the SDK got for a call that ended while answering', async () => {
      seedIncomingCall('voice');
      const stream = { id: 'late-stream' };
      const handler = { restoreMediaSettings: vi.fn(), userMediaStreams: [] as unknown[], stopUserMediaStream: vi.fn() };
      matrixState.client!.getMediaHandler.mockReturnValue(handler as never);
      let ended = false;
      (mockCallStore.matrixCall as Record<string, unknown>).callHasEnded = () => ended;
      mockAnswer.mockImplementationOnce(async () => {
        handler.userMediaStreams.push(stream);
        ended = true;
      });
      mockStopAudioRouting.mockClear();

      const { useCallService } = await import('./call-service');
      await useCallService().answerCall();

      expect(handler.stopUserMediaStream).toHaveBeenCalledWith(stream);
      // Samsung 2026-10-08: the late native audio start raised MODE_IN_COMMUNICATION
      // for 27 s after the teardown had reset it.
      expect(mockStopAudioRouting).toHaveBeenCalledWith({ callId: 'incoming-call-id' });
    });

    // Samsung 2026-10-08, the answer side of the failed placement: answer()
    // threw after the hangup, the finalize was already done, the late stream
    // and the mode it raised stayed.
    it('releases the late stream and the stranded mode when answering fails after the hangup', async () => {
      seedIncomingCall('voice');
      const stream = { id: 'late-stream-answer-error' };
      const handler = { restoreMediaSettings: vi.fn(), userMediaStreams: [] as unknown[], stopUserMediaStream: vi.fn() };
      matrixState.client!.getMediaHandler.mockReturnValue(handler as never);
      let ended = false;
      (mockCallStore.matrixCall as Record<string, unknown>).callHasEnded = () => ended;
      mockAnswer.mockImplementationOnce(async () => {
        handler.userMediaStreams.push(stream);
        ended = true;
        throw new Error('answer failed after the hangup');
      });
      mockStopAudioRouting.mockClear();

      const { useCallService } = await import('./call-service');
      await useCallService().answerCall();

      expect(handler.stopUserMediaStream).toHaveBeenCalledWith(stream);
      expect(mockStopAudioRouting).toHaveBeenCalledWith({ callId: 'incoming-call-id' });
    });

    // Review 2026-10-08: the next invite already ringing in the slot owns no
    // media, but it used to keep the ended call's late stream (and the mic) open.
    it('stops that stream even when the next call already rings in the slot', async () => {
      seedIncomingCall('voice');
      const stream = { id: 'late-stream-2' };
      const handler = { restoreMediaSettings: vi.fn(), userMediaStreams: [] as unknown[], stopUserMediaStream: vi.fn() };
      matrixState.client!.getMediaHandler.mockReturnValue(handler as never);
      let ended = false;
      (mockCallStore.matrixCall as Record<string, unknown>).callHasEnded = () => ended;
      mockAnswer.mockImplementationOnce(async () => {
        handler.userMediaStreams.push(stream);
        ended = true;
        mockCallStore.matrixCall = { callId: 'next-ringing', state: 'ringing', callHasEnded: () => false } as never;
      });

      const { useCallService } = await import('./call-service');
      await useCallService().answerCall();

      expect(handler.stopUserMediaStream).toHaveBeenCalledWith(stream);
    });

    // Review 2026-10-08 (AND3): the next call's getUserMedia raised the call
    // audio mode before its routing claimed the owner; this call's late stop
    // reset it.
    it('does not stop the audio routing while the next call is being answered', async () => {
      seedIncomingCall('voice');
      let ended = false;
      (mockCallStore.matrixCall as Record<string, unknown>).callHasEnded = () => ended;
      mockAnswer.mockImplementationOnce(async () => {
        ended = true;
        mockCallStore.matrixCall = { callId: 'next-answering', state: 'wait_local_media', callHasEnded: () => false } as never;
      });
      mockStopAudioRouting.mockClear();

      const { useCallService } = await import('./call-service');
      await useCallService().answerCall();

      expect(mockStopAudioRouting).not.toHaveBeenCalled();
    });

    it('leaves the streams alone when the next call in the slot is already being answered', async () => {
      seedIncomingCall('voice');
      const stream = { id: 'next-calls-stream' };
      const handler = { restoreMediaSettings: vi.fn(), userMediaStreams: [] as unknown[], stopUserMediaStream: vi.fn() };
      matrixState.client!.getMediaHandler.mockReturnValue(handler as never);
      let ended = false;
      (mockCallStore.matrixCall as Record<string, unknown>).callHasEnded = () => ended;
      mockAnswer.mockImplementationOnce(async () => {
        handler.userMediaStreams.push(stream);
        ended = true;
        mockCallStore.matrixCall = { callId: 'next-answering', state: 'wait_local_media', callHasEnded: () => false } as never;
      });

      const { useCallService } = await import('./call-service');
      await useCallService().answerCall();

      expect(handler.stopUserMediaStream).not.toHaveBeenCalled();
    });

    it('keeps the page audible for the answered call before the native call screen hides it', async () => {
      seedIncomingCall('voice');

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();

      expect(mockHoldPageAwake).toHaveBeenCalledWith('incoming-call-id');
      expect(mockHoldPageAwake.mock.invocationCallOrder[0]).toBeLessThan(
        mockNativeWebRTCMethods.launchCallUI.mock.invocationCallOrder[0],
      );
    });
  });

  describe('pre-accepted incoming call', () => {
    it('keeps the page audible before the fast path launches the call screen', async () => {
      const { consumePendingAnswerCallId } = await import('@/shared/lib/native-calls');
      vi.mocked(consumePendingAnswerCallId).mockResolvedValueOnce(true);
      const call = {
        callId: 'pre-accepted-call-id',
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
      mockCallStore.matrixCall = call;

      const { useCallService } = await import('./call-service');
      await useCallService().handleIncomingCall(call as never);

      expect(mockNativeWebRTCMethods.launchCallUI).toHaveBeenCalledWith(
        expect.objectContaining({ callId: 'pre-accepted-call-id', direction: 'incoming' }),
      );
      expect(mockHoldPageAwake).toHaveBeenCalledWith('pre-accepted-call-id');
      expect(mockHoldPageAwake.mock.invocationCallOrder[0]).toBeLessThan(
        mockNativeWebRTCMethods.launchCallUI.mock.invocationCallOrder[0],
      );
      // Let the fast path's own answerCall finish inside this test.
      await vi.waitFor(() => expect(mockAnswer).toHaveBeenCalled());
    });
  });

  // -------------------------------------------------------------------------
  // H3: if call.answer never resolves (SDK wedged on peer-connection setup,
  // network partition, OEM audio routing hang), the call stays "connecting…"
  // indefinitely and the user perceives it as "crashed" / "hung up" (#268,
  // #309). A 30s watchdog forces transition to failed with full cleanup.
  // -------------------------------------------------------------------------
  describe('answerCall connecting watchdog (H3)', () => {
    function seedIncomingCall(type: 'voice' | 'video' = 'voice') {
      mockCallStore.matrixCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type,
        on: mockOn,
        off: mockOff,
        answer: mockAnswer,
        reject: mockReject,
        localUsermediaStream: null,
        localScreensharingStream: null,
        remoteUsermediaStream: null,
        remoteScreensharingStream: null,
        remoteUsermediaFeed: null,
      };
      mockCallStore.activeCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type,
        direction: 'incoming',
        peerName: 'Peer',
        status: 'incoming',
      };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('transitions status to failed after 30s of stuck connecting', async () => {
      vi.useFakeTimers();
      seedIncomingCall('voice');
      // call.answer never resolves — simulate SDK wedge.
      mockAnswer.mockReturnValue(new Promise<void>(() => {}));

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      // Start answer flow (do not await — the promise won't settle)
      void service.answerCall();
      // Flush microtasks so preflight + updateStatus(connecting) complete.
      await vi.advanceTimersByTimeAsync(0);

      // At this point we're in connecting, NOT failed.
      const failedBefore = mockUpdateStatus.mock.calls.filter((c: unknown[]) => c[0] === 'failed');
      expect(failedBefore).toHaveLength(0);

      // Keep activeCall.status sticky at connecting so the watchdog
      // interprets the state as actually stuck (without a real store the
      // updateStatus calls don't propagate back to activeCall).
      (mockCallStore.activeCall as { status: string }).status = 'connecting';

      // Advance past the watchdog deadline.
      await vi.advanceTimersByTimeAsync(30_000);

      const failedAfter = mockUpdateStatus.mock.calls.filter((c: unknown[]) => c[0] === 'failed');
      expect(failedAfter.length).toBeGreaterThanOrEqual(1);
      expect(mockNativeWebRTCMethods.dismissCallUI).toHaveBeenCalled();
    });

    it('does NOT force failed when the call connected within the watchdog window', async () => {
      vi.useFakeTimers();
      seedIncomingCall('voice');
      mockAnswer.mockResolvedValue(undefined);

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();
      await vi.advanceTimersByTimeAsync(0);

      // Simulate state transition to connected — watchdog must be cancelled.
      (mockCallStore.activeCall as { status: string }).status = 'connected';

      // Advance past 30s.
      await vi.advanceTimersByTimeAsync(30_000);

      const failedCalls = mockUpdateStatus.mock.calls.filter((c: unknown[]) => c[0] === 'failed');
      expect(failedCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // WEE-47 (#836): callee UI parity — control panel must render after accept
  // on the native non-pre-accepted incoming flow.
  //
  // On Android, when Matrix /sync delivers `m.call.invite` before the user
  // taps Accept on the native IncomingCallActivity, handleIncomingCall enters
  // its `if (isNative)` branch which keeps callStore.activeCall null on
  // purpose (so the Vue IncomingCallModal does not double-ring over the
  // native one). When NativeCallBridge later fires callAnswered → answerCall,
  // the function used to run with matrixCall set and activeCall still null —
  // every subsequent store mutation (updateStatus, type upgrade) was a no-op,
  // so CallWindow.show stayed false and the callee saw no mute/speaker/hangup
  // controls (forta-bugs#836). The fix populates activeCall synchronously
  // from matrixCall at the top of answerCall so the rest of the flow has a
  // real CallInfo to mutate.
  // -------------------------------------------------------------------------
  describe('answerCall populates activeCall on native non-pre-accepted flow (WEE-47 / #836)', () => {
    function seedMatrixCallOnly(type: 'voice' | 'video' = 'voice') {
      mockCallStore.matrixCall = {
        callId: 'native-ringer-call-id',
        roomId: '!room:matrix.org',
        type,
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
      mockCallStore.activeCall = null;
    }

    it('seeds callStore.activeCall from matrixCall before updateStatus(connecting)', async () => {
      seedMatrixCallOnly('voice');

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();

      // The seed must run before any updateStatus, otherwise the
      // connecting transition is lost on an empty activeCall.
      const seedSetCall = mockSetActiveCall.mock.calls.find(
        ([info]) =>
          (info as { callId?: string; status?: string }).callId === 'native-ringer-call-id'
          && (info as { status?: string }).status === 'incoming',
      );
      expect(seedSetCall).toBeTruthy();
      // The seeded CallInfo must carry the SDK call's type + roomId so the
      // CallWindow.show gate (`status in {ringing, connecting, connected}`)
      // and the type-aware UI (voice vs video layout) work post-accept.
      expect(seedSetCall?.[0]).toMatchObject({
        callId: 'native-ringer-call-id',
        roomId: '!room:matrix.org',
        type: 'voice',
        direction: 'incoming',
      });

      // Sanity: SDK answer must still be invoked exactly once on this flow.
      expect(mockAnswer).toHaveBeenCalledTimes(1);
    });

    it('seeds activeCall.type = "video" for a video incoming call', async () => {
      seedMatrixCallOnly('video');

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();

      const seedSetCall = mockSetActiveCall.mock.calls.find(
        ([info]) =>
          (info as { callId?: string }).callId === 'native-ringer-call-id'
          && (info as { status?: string }).status === 'incoming',
      );
      expect(seedSetCall?.[0]).toMatchObject({ type: 'video' });
      // videoMuted defaults to false for video so the local camera turns on.
      expect(mockCallStore.videoMuted).toBe(false);
    });

    it('does NOT re-seed activeCall when it was already populated (pre-accepted / Vue ringer flow)', async () => {
      // Pre-accepted path or web Vue ringer path: handleIncomingCall already
      // wrote activeCall. The lazy-seed guard must be a strict `if (null)`
      // so we don't overwrite the existing CallInfo (which may carry the
      // refreshed peerName, startedAt sentinel, etc.).
      mockCallStore.matrixCall = {
        callId: 'pre-accepted-id',
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
      mockCallStore.activeCall = {
        callId: 'pre-accepted-id',
        roomId: '!room:matrix.org',
        type: 'voice',
        direction: 'incoming',
        peerName: 'Already Resolved',
        status: 'incoming',
      };

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();

      // No seed setActiveCall with status='incoming' should fire — the
      // existing activeCall must be left untouched by the lazy-seed branch.
      // (Other setActiveCall calls — e.g. peer-name patch — are allowed but
      // must NOT carry status='incoming', which is the seed signature.)
      const seedSetCall = mockSetActiveCall.mock.calls.find(
        ([info]) =>
          (info as { callId?: string }).callId === 'pre-accepted-id'
          && (info as { status?: string }).status === 'incoming'
          && (info as { peerName?: string }).peerName !== 'Already Resolved',
      );
      expect(seedSetCall).toBeFalsy();
    });
  });
});

describe('releaseOrphanedNativeAnswer', () => {
  it('finalizes the native call when no call is live in JS', async () => {
    const { __resetFinalizeCallStateForTests } = await import('./finalize-call');
    __resetFinalizeCallStateForTests();
    mockCallStore.hasLiveCall = false;
    const { useCallService } = await import('./call-service');
    useCallService().releaseOrphanedNativeAnswer('orphan-native', '!room:matrix.org');
    await vi.waitFor(() => expect(mockReportCallEnded).toHaveBeenCalledWith('orphan-native'));
  });

  it('leaves the native side alone while a call is live', async () => {
    const { __resetFinalizeCallStateForTests } = await import('./finalize-call');
    __resetFinalizeCallStateForTests();
    mockReportCallEnded.mockClear();
    mockCallStore.hasLiveCall = true;
    try {
      const { useCallService } = await import('./call-service');
      useCallService().releaseOrphanedNativeAnswer('other-native', '!room:matrix.org');
      await new Promise((r) => setTimeout(r, 50));
      expect(mockReportCallEnded).not.toHaveBeenCalled();
    } finally {
      mockCallStore.hasLiveCall = false;
    }
  });
});
