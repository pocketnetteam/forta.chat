// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { tRaw } from '@/shared/lib/i18n';
import {
  mockNativeWebRTCMethods,
  mockStartAudioRouting,
  MockPermissionDeniedError,
  mockEnsureCallPermissions,
  mockUpdateStatus,
  mockScheduleClearCall,
  mockSetActiveCall,
  mockSetMatrixCall,
  mockCallStore,
  mockPlaceVoiceCall,
  mockPlaceVideoCall,
  mockAnswer,
  mockReject,
  mockOn,
  mockOff,
  matrixState,
  authState,
  mockLoadUsersBatch,
  mockGetUser,
  toastMessage,
  toastSpy,
  toastCloseSpy,
  mockHoldPageAwake,
  resetCallServiceHarness,
} from './call-service.harness';

describe('call-service: placing a call', () => {
  beforeEach(resetCallServiceHarness);

  describe('startCall', () => {
    it('calls ensureCallPermissions with isVideo=false for voice call', async () => {
      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      expect(mockEnsureCallPermissions).toHaveBeenCalledWith(false);
    });

    it('calls ensureCallPermissions with isVideo=true for video call', async () => {
      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'video');

      expect(mockEnsureCallPermissions).toHaveBeenCalledWith(true);
    });

    it('sets CallStatus.failed and returns early when microphone denied', async () => {
      mockEnsureCallPermissions.mockRejectedValueOnce(
        new MockPermissionDeniedError('microphone'),
      );

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      expect(mockUpdateStatus).toHaveBeenCalledWith('failed');
      expect(mockScheduleClearCall).toHaveBeenCalled();
      expect(mockPlaceVoiceCall).not.toHaveBeenCalled();
    });

    it('sets CallStatus.failed and skips placeVideoCall when camera denied for video', async () => {
      mockEnsureCallPermissions.mockRejectedValueOnce(
        new MockPermissionDeniedError('camera'),
      );

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'video');

      expect(mockUpdateStatus).toHaveBeenCalledWith('failed');
      expect(mockPlaceVideoCall).not.toHaveBeenCalled();
    });

    it('does not start audio routing when permission denied', async () => {
      mockEnsureCallPermissions.mockRejectedValueOnce(
        new MockPermissionDeniedError('microphone'),
      );

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      expect(mockStartAudioRouting).not.toHaveBeenCalled();
    });

    it('keeps the page audible for an outgoing call before the native call screen hides it', async () => {
      // Chromium freezes a hidden, silent page after a minute. A frozen page
      // never hears the peer hang up, so the call screen stays open.
      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      expect(mockNativeWebRTCMethods.launchCallUI).toHaveBeenCalledWith(
        expect.objectContaining({ callId: 'test-call-id', direction: 'outgoing' }),
      );
      expect(mockHoldPageAwake).toHaveBeenCalledWith('test-call-id');
      expect(mockHoldPageAwake.mock.invocationCallOrder[0]).toBeLessThan(
        mockNativeWebRTCMethods.launchCallUI.mock.invocationCallOrder[0],
      );
    });

    it('resets the ended call\'s state before dialling (clear window)', async () => {
      const clearCall = mockCallStore.clearCall as Mock;
      clearCall.mockClear();
      const { useCallService } = await import('./call-service');
      await useCallService().startCall('!room:matrix.org', 'voice');
      expect(clearCall).toHaveBeenCalled();
      expect(clearCall.mock.invocationCallOrder[0]).toBeLessThan(mockSetActiveCall.mock.invocationCallOrder[0]);
    });

    // WEE-49 / forta-bugs#460: a fast double-tap on the dial button (or a
    // JS-event re-emit from CallEventCard's call-back handler) used to slip
    // past the `isInCall` check while the first invocation was still awaiting
    // ensureCallPermissions — producing two outgoing call dialogs.
    it('ignores re-entrant startCall while the first is in flight (forta-bugs#460)', async () => {
      // Suspend the first permission check so we can fire a second startCall
      // while the first one is parked between entry and setActiveCall. The
      // dedup guard must short-circuit the second call without invoking
      // ensureCallPermissions a second time.
      let resolveFirst: (() => void) | undefined;
      mockEnsureCallPermissions.mockImplementationOnce(
        () => new Promise<void>((res) => { resolveFirst = () => res(); }),
      );

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      const first = service.startCall('!room:matrix.org', 'voice');

      // Let the first call actually reach ensureCallPermissions before we
      // fire the second one — the readiness wait in front of it takes a few
      // microtasks, so a single yield is not enough.
      await vi.waitFor(() => expect(mockEnsureCallPermissions).toHaveBeenCalledTimes(1));

      const second = service.startCall('!room:matrix.org', 'voice');
      await second;
      // Only the first startCall reached ensureCallPermissions.
      expect(mockEnsureCallPermissions).toHaveBeenCalledTimes(1);
      // And no extra place*Call landed on the SDK for the duplicate.
      expect(mockPlaceVoiceCall).not.toHaveBeenCalled();

      // Unblock the first invocation so the test cleanup does not leak it.
      resolveFirst?.();
      await first;
    });

    it('clears the dedup lock after a failed dial (subsequent startCall works)', async () => {
      mockEnsureCallPermissions.mockRejectedValueOnce(
        new MockPermissionDeniedError('microphone'),
      );

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      // Second startCall must reach ensureCallPermissions again — the dedup
      // guard set in `finally` must be reset even on the denied-permission
      // path or the user would be locked out of dialing until reload.
      await service.startCall('!room:matrix.org', 'voice');
      expect(mockEnsureCallPermissions).toHaveBeenCalledTimes(2);
    });
  });

  // Right after a cold start the chat list is up while Matrix is still
  // connecting. A dial in that window used to find no client and return
  // without a word — the button did nothing. Now it waits for `matrixReady`
  // for a bounded time, and says so when the wait runs out.
  // The previous call's finalize is still walking the native steps when
  // `hasLiveCall` already reads false; each step is process-wide, so a dial
  // placed in that window would have them land on the new call.
  describe('startCall while the previous call finalizes', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('waits for the in-flight finalize before dialling', async () => {
      vi.useFakeTimers();
      let releaseDismiss!: () => void;
      mockNativeWebRTCMethods.dismissCallUI.mockReturnValueOnce(
        new Promise<void>((resolve) => { releaseDismiss = resolve; }),
      );
      const { finalizeCall } = await import('./finalize-call');
      const { useCallService } = await import('./call-service');

      const previous = finalizeCall('hangup', 'previous-call-id');
      await vi.advanceTimersByTimeAsync(0);
      expect(mockNativeWebRTCMethods.dismissCallUI).toHaveBeenCalledWith({ callId: 'previous-call-id' });

      const pending = useCallService().startCall('!room:matrix.org', 'voice');
      await vi.advanceTimersByTimeAsync(200);
      expect(mockPlaceVoiceCall).not.toHaveBeenCalled();

      releaseDismiss();
      await previous;
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      expect(mockPlaceVoiceCall).toHaveBeenCalledTimes(1);
    });

    it('dials anyway once FINALIZE_SETTLE_WAIT_MS has passed', async () => {
      vi.useFakeTimers();
      mockNativeWebRTCMethods.dismissCallUI.mockReturnValueOnce(new Promise<void>(() => {}));
      const { finalizeCall, FINALIZE_SETTLE_WAIT_MS } = await import('./finalize-call');
      const { useCallService } = await import('./call-service');

      void finalizeCall('hangup', 'stuck-call-id');
      await vi.advanceTimersByTimeAsync(0);

      const pending = useCallService().startCall('!room:matrix.org', 'voice');
      await vi.advanceTimersByTimeAsync(FINALIZE_SETTLE_WAIT_MS - 1);
      expect(mockPlaceVoiceCall).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(mockPlaceVoiceCall).toHaveBeenCalledTimes(1);
    });
  });

  describe('startCall before Matrix is ready', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('waits for matrixReady, then dials — once, without asking for the mic meanwhile', async () => {
      vi.useFakeTimers();
      authState.matrixReady = false;
      const { useCallService, MATRIX_READY_WAIT_MS } = await import('./call-service');
      const service = useCallService();

      const pending = service.startCall('!room:matrix.org', 'voice');
      await vi.advanceTimersByTimeAsync(0);

      expect(toastSpy).toHaveBeenCalledWith(
        tRaw('call.info.waitingForServer'),
        'info',
        MATRIX_READY_WAIT_MS,
      );
      expect(mockEnsureCallPermissions).not.toHaveBeenCalled();

      // A second tap during the wait is the double-tap the outgoing lock
      // already guards against — it must not queue a second dial.
      await service.startCall('!room:matrix.org', 'voice');

      await vi.advanceTimersByTimeAsync(2000);
      authState.matrixReady = true;
      await vi.advanceTimersByTimeAsync(0);
      await pending;

      expect(mockEnsureCallPermissions).toHaveBeenCalledTimes(1);
      expect(mockEnsureCallPermissions).toHaveBeenCalledWith(false);
      expect(mockPlaceVoiceCall).toHaveBeenCalledTimes(1);
      // The "connecting…" toast must not sit over the call screen.
      expect(toastCloseSpy).toHaveBeenCalled();
      expect(toastSpy).not.toHaveBeenCalledWith(
        tRaw('call.error.matrixNotReady'),
        expect.anything(),
        expect.anything(),
      );
    });

    it('gives up after MATRIX_READY_WAIT_MS with an error toast and releases the lock', async () => {
      vi.useFakeTimers();
      authState.matrixReady = false;
      const { useCallService, MATRIX_READY_WAIT_MS } = await import('./call-service');
      const service = useCallService();

      const pending = service.startCall('!room:matrix.org', 'voice');
      await vi.advanceTimersByTimeAsync(MATRIX_READY_WAIT_MS - 1);
      expect(toastSpy).not.toHaveBeenCalledWith(
        tRaw('call.error.matrixNotReady'),
        expect.anything(),
        expect.anything(),
      );

      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(toastSpy).toHaveBeenCalledWith(
        tRaw('call.error.matrixNotReady'),
        'error',
        expect.any(Number),
      );
      expect(mockEnsureCallPermissions).not.toHaveBeenCalled();
      expect(mockPlaceVoiceCall).not.toHaveBeenCalled();
      // No CallInfo was ever written, so there is no call to mark failed.
      expect(mockUpdateStatus).not.toHaveBeenCalledWith('failed');

      // The dropped dial must not lock the button: once Matrix is up, the
      // next tap dials.
      authState.matrixReady = true;
      await service.startCall('!room:matrix.org', 'voice');
      expect(mockPlaceVoiceCall).toHaveBeenCalledTimes(1);
    });

    it('does not dial when a call arrived while it was waiting', async () => {
      vi.useFakeTimers();
      authState.matrixReady = false;
      const { useCallService } = await import('./call-service');
      const service = useCallService();

      const pending = service.startCall('!room:matrix.org', 'voice');
      await vi.advanceTimersByTimeAsync(1000);

      // An incoming call rings (Telecom, no CallInfo yet) during the wait:
      // dialling now would overwrite the single MatrixCall slot (#1183).
      mockCallStore.hasLiveCall = true;
      authState.matrixReady = true;
      await vi.advanceTimersByTimeAsync(0);
      await pending;

      expect(mockEnsureCallPermissions).not.toHaveBeenCalled();
      expect(mockPlaceVoiceCall).not.toHaveBeenCalled();
    });

    it('leaves an unrelated toast alone when the wait ends', async () => {
      vi.useFakeTimers();
      authState.matrixReady = false;
      const { useCallService } = await import('./call-service');
      const service = useCallService();

      const pending = service.startCall('!room:matrix.org', 'voice');
      await vi.advanceTimersByTimeAsync(1000);

      // Another feature replaced the "connecting…" toast meanwhile.
      toastMessage.value = 'link copied';
      authState.matrixReady = true;
      await vi.advanceTimersByTimeAsync(0);
      await pending;

      expect(mockPlaceVoiceCall).toHaveBeenCalledTimes(1);
      expect(toastCloseSpy).not.toHaveBeenCalled();
    });

    it('tells the user when the client is gone although matrixReady says otherwise', async () => {
      matrixState.client = null;
      const { useCallService } = await import('./call-service');
      const service = useCallService();

      await service.startCall('!room:matrix.org', 'voice');

      expect(toastSpy).toHaveBeenCalledWith(
        tRaw('call.error.matrixNotReady'),
        'error',
        expect.any(Number),
      );
      expect(mockEnsureCallPermissions).not.toHaveBeenCalled();
      expect(mockPlaceVoiceCall).not.toHaveBeenCalled();
    });
  });

  describe('glare resolved by the SDK', () => {
    // Regression: replacedBy() answered the other side's call without
    // Call.incoming — a live call with the mic open and no UI.
    it('hangs the successor call up', async () => {
      const { useCallService } = await import('./call-service');
      await useCallService().startCall('!room:matrix.org', 'voice');
      const onReplaced = mockOn.mock.calls.filter((c: unknown[]) => c[0] === 'Replaced').at(-1)?.[1] as (n: unknown) => void;
      const successor = { callId: 'successor', hangup: vi.fn() };
      onReplaced(successor);
      expect(successor.hangup).toHaveBeenCalledWith('user_hangup', false);
    });
  });

  describe('an incoming call while dialling out', () => {
    // Regression: the dial reaches the call slot only after several awaits,
    // so an incoming call in that window took the slot and stranded the dial
    // (no call screen, a Telecom connection left DIALING).
    it('is rejected as busy and does not take the slot', async () => {
      const { useCallService } = await import('./call-service');
      const service = useCallService();
      const dialling = service.startCall('!room:matrix.org', 'voice');
      await Promise.resolve();
      mockSetMatrixCall.mockClear();
      const reject = vi.fn();
      await service.handleIncomingCall({
        callId: 'crossing-call',
        roomId: '!room:matrix.org',
        type: 'voice',
        on: vi.fn(),
        off: vi.fn(),
        reject,
        getOpponentMember: vi.fn(() => ({ userId: '@peer:matrix.org' })),
      } as never);
      await dialling;
      expect(reject).toHaveBeenCalled();
      expect(mockSetMatrixCall).not.toHaveBeenCalledWith(expect.objectContaining({ callId: 'crossing-call' }));
    });
  });

  describe('outgoing ringback gating (#866 / WEE-54)', () => {
    function captureOnState() {
      const stateCall = mockOn.mock.calls.find((c: unknown[]) => c[0] === 'State');
      return stateCall?.[1] as
        | ((newState: string, oldState: string) => void)
        | undefined;
    }

    it('does NOT play the ringback synchronously when the call is dialed', async () => {
      const { playDialtone } = await import('./call-sounds');
      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      // The dial tone must not fire just because placeVoiceCall resolved —
      // only the SDK InviteSent transition is allowed to start it.
      expect(vi.mocked(playDialtone)).not.toHaveBeenCalled();
    });

    it('plays the ringback once the SDK reports InviteSent (invite delivered)', async () => {
      const { playDialtone } = await import('./call-sounds');
      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      const onState = captureOnState();
      expect(onState).toBeTruthy();

      // SDK transitions CreateOffer → InviteSent once the invite is sent.
      onState?.('invite_sent', 'create_offer');
      expect(vi.mocked(playDialtone)).toHaveBeenCalledTimes(1);
    });

    it('does NOT play the ringback during pre-invite states (local media / offer setup)', async () => {
      const { playDialtone } = await import('./call-sounds');
      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      const onState = captureOnState();
      // None of the pre-invite states should trigger the dial tone — this is
      // exactly the window where the phantom ringback used to play.
      onState?.('wait_local_media', 'fledgling');
      onState?.('create_offer', 'wait_local_media');
      expect(vi.mocked(playDialtone)).not.toHaveBeenCalled();
    });

    it('starts the ringback at most once even if InviteSent is observed twice', async () => {
      const { playDialtone } = await import('./call-sounds');
      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      const onState = captureOnState();
      onState?.('invite_sent', 'create_offer');
      onState?.('invite_sent', 'invite_sent');
      expect(vi.mocked(playDialtone)).toHaveBeenCalledTimes(1);
    });

    it('does NOT play the ringback for an incoming call on InviteSent', async () => {
      // Defensive: the gate is keyed on direction === "outgoing". An incoming
      // call must never emit the outgoing dial tone.
      const { playDialtone } = await import('./call-sounds');
      const { useCallService } = await import('./call-service');
      const service = useCallService();

      mockCallStore.matrixCall = {
        callId: 'incoming-call-id',
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
      await service.handleIncomingCall(mockCallStore.matrixCall as never);

      const onState = captureOnState();
      onState?.('invite_sent', 'create_offer');
      expect(vi.mocked(playDialtone)).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Session 30: resolvePeerInfo / refreshPeerNameAsync — close #645.
  //
  // Pre-Session-30 the peer's profile was loaded fire-and-forget and the
  // result was read on the next line, so cold-cache calls fell through to
  // the raw blockchain address — rendered as "Unknown" by the native
  // ringer and as a long opaque string in Vue surfaces. We now race a real
  // loadUsersBatch against a 500ms timer for the initial setActiveCall and
  // patch the name in via a follow-up update once the network reply lands.
  // -------------------------------------------------------------------------
  // Lazy-loaded members: a room that was not opened this session may hold
  // only the own member, so the outgoing call had no peer (empty peerId).
  describe('peer of a room with lazy-loaded members', () => {
    it('loads the members before picking the peer', async () => {
      const joined = [{ userId: '@me:matrix.org' }];
      let loaded = false;
      const loadMembersIfNeeded = vi.fn(async () => {
        joined.push({ userId: '@peer:matrix.org' });
        loaded = true;
        return true;
      });
      matrixState.client!.getRoom.mockReturnValue({
        getJoinedMembers: () => joined,
        membersLoaded: () => loaded,
        loadMembersIfNeeded,
        getMyMembership: () => 'join',
      } as never);

      const { useCallService } = await import('./call-service');
      await useCallService().startCall('!room:matrix.org', 'voice');

      expect(loadMembersIfNeeded).toHaveBeenCalledTimes(1);
      const setCall = mockSetActiveCall.mock.calls.find(
        ([info]) => (info as { peerId?: string }).peerId === '@peer:matrix.org',
      );
      expect(setCall).toBeTruthy();
    });
  });

  describe('peer profile resolution (#645)', () => {
    it('uses the cached profile name when the user is already in the store', async () => {
      mockGetUser.mockReturnValue({ name: 'Cached Peer' });

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      // Hot cache: initial setActiveCall must already carry the real name,
      // not the address fallback. (loadUsersBatch may still fire from the
      // background refreshPeerNameAsync — that path is exercised by the
      // late-arriving-profile test below.)
      const initialCall = mockSetActiveCall.mock.calls.find(
        ([info]) => (info as { peerName?: string }).peerName === 'Cached Peer',
      );
      expect(initialCall).toBeTruthy();
    });

    it('waits for loadUsersBatch and uses the fetched name when cache is cold', async () => {
      // First read returns no cached profile, second read (after the await
      // inside resolvePeerInfo) finds the freshly-fetched profile. This
      // mirrors what the real userStore does: the batch updates the same
      // ref the getter reads from.
      mockGetUser
        .mockReturnValueOnce(undefined)
        .mockReturnValue({ name: 'Fetched Peer' });

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      expect(mockLoadUsersBatch).toHaveBeenCalledWith(['@peer:matrix.org']);
      const setCall = mockSetActiveCall.mock.calls.find(
        ([info]) => (info as { peerName?: string }).peerName === 'Fetched Peer',
      );
      expect(setCall).toBeTruthy();
    });

    it('falls back to the address when loadUsersBatch resolves without a name (network failure path)', async () => {
      // Cold cache, batch resolves, but the profile still has no name —
      // userStore returns {name: ''} after a failed/empty backend reply.
      mockGetUser.mockReturnValue({ name: '' });

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      // peerName falls back to peerAddress (= matrixId in this mock).
      const setCall = mockSetActiveCall.mock.calls.find(
        ([info]) => (info as { peerName?: string }).peerName === '@peer:matrix.org',
      );
      expect(setCall).toBeTruthy();
    });

    it('patches activeCall.peerName via setActiveCall when a late profile arrives', async () => {
      // Initial resolvePeerInfo: cold cache, batch resolves with empty
      // name → setActiveCall fires once with the address fallback. The
      // background refresh runs after that, and on its read we return a
      // populated profile — that is the late-arrival signal that should
      // patch peerName in.
      mockGetUser
        .mockReturnValueOnce(undefined) // resolvePeerInfo: cache check
        .mockReturnValueOnce({ name: '' }) // resolvePeerInfo: post-await read (still cold)
        .mockReturnValue({ name: 'Late Peer' }); // refreshPeerNameAsync read

      // Wire the mock store so setActiveCall actually mutates activeCall.
      // Without this, the refreshPeerNameAsync guard
      // (`active.callId !== callId`) would never see the activeCall that
      // startCall just wrote — and the test would either fail or pass
      // for the wrong reason (a stale hand-set fixture). Doing the wire
      // here also makes the call-sequence assertion below meaningful:
      // we're verifying ordered writes against the real store contract.
      mockSetActiveCall.mockImplementation((info: unknown) => {
        mockCallStore.activeCall = info as Record<string, unknown>;
      });

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      // Wait one microtask flush so the deferred refreshPeerNameAsync
      // promise can settle (it does its store patching synchronously
      // after the loadUsersBatch promise resolves).
      await new Promise((r) => setTimeout(r, 0));

      // Sequence check: first setActiveCall is the initial activeCall
      // with the address fallback; the second is the late-arriving
      // patch with the resolved name. Asserting the order (rather than
      // just .find) catches regressions where a future refactor accidentally
      // sets the late name first or fires only one write.
      expect(mockSetActiveCall.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mockSetActiveCall.mock.calls[0][0]).toMatchObject({
        peerName: '@peer:matrix.org',
      });
      const lastCall = mockSetActiveCall.mock.calls[mockSetActiveCall.mock.calls.length - 1][0];
      expect(lastCall).toMatchObject({ peerName: 'Late Peer' });
    });
  });
});
