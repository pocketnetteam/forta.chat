// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  mockNativeWebRTCMethods,
  mockStopAudioRouting,
  mockEnsureCallPermissions,
  mockUpdateStatus,
  mockScheduleClearCall,
  mockSetMatrixCall,
  mockAddHistoryEntry,
  mockCallStore,
  mockPlaceVoiceCall,
  mockPlaceVideoCall,
  mockAnswer,
  mockReject,
  mockHangup,
  mockOn,
  mockOff,
  matrixState,
  mockLoadUsersBatch,
  mockGetUser,
  torState,
  toastSpy,
  resetCallServiceHarness,
} from './call-service.harness';

describe('call-service: call events', () => {
  beforeEach(resetCallServiceHarness);

  describe('SDK errors that do not end the call', () => {
    // Regression: every CallEvent.Error tore the call down on this side only.
    // A camera that cannot start mid-call leaves a working voice call, and a
    // failed answer send leaves the call ringing — the peer stayed connected.
    async function placed() {
      const { useCallService } = await import('./call-service');
      await useCallService().startCall('!room:matrix.org', 'voice');
      const handler = (name: string) =>
        mockOn.mock.calls.filter((c: unknown[]) => c[0] === name).at(-1)?.[1] as (...a: unknown[]) => void;
      const call = mockSetMatrixCall.mock.calls.at(-1)?.[0] as { state: string; callHasEnded: ReturnType<typeof vi.fn> };
      mockUpdateStatus.mockClear();
      mockHangup.mockClear();
      return { onError: handler('Error'), onState: handler('State'), call };
    }
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it('closes a call the SDK ends after the error as failed', async () => {
      const { onError, onState, call } = await placed();
      onError({ code: 'ice_failed', message: 'ice' });
      call.callHasEnded.mockReturnValue(true);
      onState('ended', 'connecting');
      await flush();
      expect(mockUpdateStatus).toHaveBeenCalledWith('failed');
    });

    it('keeps a connected call when the camera cannot be turned on', async () => {
      const { onError, call } = await placed();
      call.state = 'connected';
      onError({ code: 'no_user_media', message: 'camera' });
      await flush();
      expect(mockUpdateStatus).not.toHaveBeenCalledWith('failed');
      expect(mockHangup).not.toHaveBeenCalled();
    });

    it('hangs up properly when the call is left alive after another error', async () => {
      const { onError, call } = await placed();
      call.state = 'ringing';
      onError({ code: 'send_answer', message: 'answer' });
      await flush();
      expect(mockHangup).toHaveBeenCalledWith('send_answer', false);
    });
  });

  describe('reconnect after an ICE restart', () => {
    // Regression: the SDK sets Connected again after a network handover, and
    // each time the timer restarted from 0 and startedAt moved, so the call's
    // duration in history counted only from the last blip.
    it('starts the timer once even if Connected is reported again', async () => {
      const { useCallService } = await import('./call-service');
      await useCallService().startCall('!room:matrix.org', 'voice');
      const onState = mockOn.mock.calls.find((c: unknown[]) => c[0] === 'State')?.[1] as
        (newState: string, oldState: string) => void;
      (mockCallStore.startTimer as ReturnType<typeof vi.fn>).mockClear();

      onState('connected', 'connecting');
      onState('connecting', 'connected');
      onState('connected', 'connecting');

      expect(mockCallStore.startTimer as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// WEE-89 — camera/mic released after a call (web recording-indicator leak,
// regression of WEE-47). matrix-js-sdk doesn't reliably stop the local
// getUserMedia tracks on web, so the tab's 🔴 indicator stays lit and the
// mic stays captured after ended/hangup/reject. The fix stops every local
// track on all teardown paths via releaseLocalMedia().
// ---------------------------------------------------------------------------
describe('local media release on call teardown (WEE-89)', () => {

  // C03 (calls review 2026-10-04): hung up while placeVoiceCall waited for
  // getUserMedia — the SDK still built a peer connection and kept the stream
  // in MediaHandler without a feed, after the teardown had already run.
  it('releases the stream and peer connection a call placed after its hangup got', async () => {
    const stream = { id: 'late-stream' };
    const handler = { restoreMediaSettings: vi.fn(), userMediaStreams: [] as unknown[], stopUserMediaStream: vi.fn() };
    matrixState.client!.getMediaHandler.mockReturnValue(handler as never);
    const pc = { close: vi.fn() };
    mockPlaceVoiceCall.mockImplementationOnce(function (this: Record<string, unknown>) {
      handler.userMediaStreams.push(stream);
      this.peerConn = pc;
      this.callHasEnded = () => true;
      return Promise.resolve();
    });

    const { useCallService } = await import('./call-service');
    await useCallService().startCall('!room:matrix.org', 'voice');

    expect(handler.stopUserMediaStream).toHaveBeenCalledWith(stream);
    expect(pc.close).toHaveBeenCalled();
    // Samsung 2026-10-08: the late native audio start raised MODE_IN_COMMUNICATION
    // after the teardown; a stop keyed by this call resets that stranded mode.
    expect(mockStopAudioRouting).toHaveBeenCalledWith({ callId: expect.any(String) });
  });

  // Samsung 2026-10-08: after the hangup placeVoiceCall went on and failed
  // ("Invalid ICE server configuration"). The error path released only the
  // call's own feeds, so the late stream stayed live and the mode stuck ~40 s.
  it('releases the late stream and the stranded mode when placing fails after the hangup', async () => {
    const stream = { id: 'late-stream-error' };
    const handler = { restoreMediaSettings: vi.fn(), userMediaStreams: [] as unknown[], stopUserMediaStream: vi.fn() };
    matrixState.client!.getMediaHandler.mockReturnValue(handler as never);
    mockPlaceVoiceCall.mockImplementationOnce(function (this: Record<string, unknown>) {
      handler.userMediaStreams.push(stream);
      this.callHasEnded = () => true;
      return Promise.reject(new Error("Couldn't start call! Invalid ICE server configuration."));
    });
    mockStopAudioRouting.mockClear();

    const { useCallService } = await import('./call-service');
    await useCallService().startCall('!room:matrix.org', 'voice');

    expect(handler.stopUserMediaStream).toHaveBeenCalledWith(stream);
    expect(mockStopAudioRouting).toHaveBeenCalledWith({ callId: expect.any(String) });
  });

  // Review 2026-10-08 (TS1): by the time a placement fails after its hangup,
  // the next call may hold the slot; its status, handlers and slot are not
  // this call's to fail and clear.
  it('leaves the next call in the slot alone when placing fails after the hangup', async () => {
    const next = { callId: 'next-call', state: 'ringing', callHasEnded: () => false };
    mockPlaceVoiceCall.mockImplementationOnce(function (this: Record<string, unknown>) {
      this.callHasEnded = () => true;
      mockCallStore.matrixCall = next;
      return Promise.reject(new Error('late failure after the hangup'));
    });
    mockUpdateStatus.mockClear();
    mockScheduleClearCall.mockClear();

    const { useCallService } = await import('./call-service');
    await useCallService().startCall('!room:matrix.org', 'voice');

    expect(mockUpdateStatus).not.toHaveBeenCalledWith('failed');
    expect(mockScheduleClearCall).not.toHaveBeenCalled();
    expect(mockCallStore.matrixCall).toBe(next);
  });
  beforeEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mockCallStore.isInCall = false;
    mockCallStore.activeCall = null;
    mockCallStore.matrixCall = null;
    mockCallStore.videoMuted = false;
    mockEnsureCallPermissions.mockResolvedValue(undefined);
    mockGetUser.mockReset();
    mockGetUser.mockReturnValue({ name: 'Peer' });
    mockLoadUsersBatch.mockReset();
    mockLoadUsersBatch.mockResolvedValue(undefined);
    const { __resetFinalizeCallStateForTests } = await import('./finalize-call');
    __resetFinalizeCallStateForTests();
  });

  /** Track stub whose stop() is observable. */
  function track(stop: Mock) {
    return { stop } as unknown as MediaStreamTrack;
  }

  /**
   * MatrixCall stub carrying observable local tracks. `on`/`off` reuse the
   * shared mocks so wireCallEvents registrations land in mockOn.mock.calls
   * and can be captured below.
   */
  function makeCallWithTracks(
    userStops: Mock[],
    screenStops: Mock[] = [],
  ): Record<string, unknown> {
    return {
      callId: 'test-call-id',
      roomId: 'test-room-id',
      type: 'voice',
      on: mockOn,
      off: mockOff,
      placeVoiceCall: mockPlaceVoiceCall,
      placeVideoCall: mockPlaceVideoCall,
      answer: mockAnswer,
      reject: mockReject,
      hangup: mockHangup,
      isMicrophoneMuted: vi.fn(() => false),
      localUsermediaStream: { getTracks: () => userStops.map(track) },
      localScreensharingStream: screenStops.length
        ? { getTracks: () => screenStops.map(track) }
        : null,
      remoteUsermediaStream: null,
      remoteScreensharingStream: null,
      remoteUsermediaFeed: null,
      getOpponentMember: vi.fn(() => ({ userId: '@peer:matrix.org' })),
    };
  }

  function captureHandler(event: string) {
    const entry = mockOn.mock.calls.find((c: unknown[]) => c[0] === event);
    return entry?.[1] as ((...args: unknown[]) => void) | undefined;
  }

  it('stops all local media tracks when the call ends (A1: web indicator clears)', async () => {
    const stopAudio = vi.fn();
    const stopVideo = vi.fn();
    const fakeCall = makeCallWithTracks([stopAudio, stopVideo]);
    const { createNewMatrixCall } = await import('matrix-js-sdk-bastyon/lib/webrtc/call');
    vi.mocked(createNewMatrixCall).mockReturnValueOnce(fakeCall as never);

    const { useCallService } = await import('./call-service');
    await useCallService().startCall('!room:matrix.org', 'voice');

    const onState = captureHandler('State');
    expect(onState).toBeTruthy();
    onState?.('ended', 'connected');

    expect(stopAudio).toHaveBeenCalledTimes(1);
    expect(stopVideo).toHaveBeenCalledTimes(1);
  });

  it('also stops screenshare tracks on call end', async () => {
    const stopMic = vi.fn();
    const stopScreen = vi.fn();
    const fakeCall = makeCallWithTracks([stopMic], [stopScreen]);
    const { createNewMatrixCall } = await import('matrix-js-sdk-bastyon/lib/webrtc/call');
    vi.mocked(createNewMatrixCall).mockReturnValueOnce(fakeCall as never);

    const { useCallService } = await import('./call-service');
    await useCallService().startCall('!room:matrix.org', 'voice');

    captureHandler('State')?.('ended', 'connected');

    expect(stopMic).toHaveBeenCalledTimes(1);
    expect(stopScreen).toHaveBeenCalledTimes(1);
  });

  it('stops local media tracks when the SDK fires Hangup before Ended', async () => {
    const stop = vi.fn();
    const fakeCall = makeCallWithTracks([stop]);
    const { createNewMatrixCall } = await import('matrix-js-sdk-bastyon/lib/webrtc/call');
    vi.mocked(createNewMatrixCall).mockReturnValueOnce(fakeCall as never);

    const { useCallService } = await import('./call-service');
    await useCallService().startCall('!room:matrix.org', 'voice');

    captureHandler('Hangup')?.();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops local media tracks on user-initiated hangup (A2: mic freed)', async () => {
    const stop = vi.fn();
    mockCallStore.matrixCall = makeCallWithTracks([stop]);

    const { useCallService } = await import('./call-service');
    useCallService().hangup();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  // Regression (web, 2026-10-05): reject() ends the SDK call synchronously, and
  // the still-wired State handler added a "missed" entry and played the end
  // tone before rejectCall added "declined" — two entries for one decline.
  it('records one declined entry and no end tone for a decline', async () => {
    const fakeCall = makeCallWithTracks([]);
    fakeCall.reject = vi.fn(() => {
      const offed = new Set(mockOff.mock.calls.map((c: unknown[]) => c[1]));
      const live = mockOn.mock.calls.filter((c: unknown[]) => c[0] === 'State' && !offed.has(c[1]));
      for (const [, handler] of live) (handler as (s: string, p: string) => void)('ended', 'ringing');
    });
    const { useCallService } = await import('./call-service');
    const service = useCallService();
    await service.handleIncomingCall(fakeCall as never);
    mockCallStore.matrixCall = fakeCall;
    mockCallStore.activeCall = {
      callId: 'test-call-id', roomId: 'test-room-id', peerId: '@peer:matrix.org', peerAddress: 'peer',
      peerName: 'Peer', type: 'voice', direction: 'incoming', status: 'incoming', startedAt: null, endedAt: null,
    };
    const { playEndTone } = await import('./call-sounds');
    vi.mocked(playEndTone).mockClear();
    mockAddHistoryEntry.mockClear();

    service.rejectCall();

    expect(mockAddHistoryEntry.mock.calls.map((c: unknown[]) => (c[0] as { status: string }).status)).toEqual(['declined']);
    expect(playEndTone).not.toHaveBeenCalled();
    mockCallStore.activeCall = null;
  });

  it('stops local media tracks on reject', async () => {
    const stop = vi.fn();
    mockCallStore.matrixCall = makeCallWithTracks([stop]);

    const { useCallService } = await import('./call-service');
    useCallService().rejectCall();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not throw on reject when no local stream was acquired (ringing reject)', async () => {
    const fakeCall = makeCallWithTracks([]);
    fakeCall.localUsermediaStream = null;
    mockCallStore.matrixCall = fakeCall;

    const { useCallService } = await import('./call-service');
    expect(() => useCallService().rejectCall()).not.toThrow();
    expect(mockReject).toHaveBeenCalled();
  });

  it('does NOT stop local media while the call is still connected (A3: active call works)', async () => {
    const stop = vi.fn();
    const fakeCall = makeCallWithTracks([stop]);
    const { createNewMatrixCall } = await import('matrix-js-sdk-bastyon/lib/webrtc/call');
    vi.mocked(createNewMatrixCall).mockReturnValueOnce(fakeCall as never);

    const { useCallService } = await import('./call-service');
    await useCallService().startCall('!room:matrix.org', 'voice');

    captureHandler('State')?.('connected', 'connecting');

    expect(stop).not.toHaveBeenCalled();
  });

  // The answerCall connecting-watchdog unwires SDK listeners before
  // call.hangup(), so onHangup/onState→ended never run — the media acquired
  // by call.answer() must be released by the watchdog itself.
  it('stops local media when the answerCall connecting-watchdog times out', async () => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn();
      const fakeCall = makeCallWithTracks([stop]);
      mockCallStore.matrixCall = fakeCall;
      mockCallStore.activeCall = {
        callId: 'test-call-id',
        roomId: 'test-room-id',
        type: 'voice',
        direction: 'incoming',
        peerName: 'Peer',
        status: 'incoming',
      };
      // call.answer resolves (media acquired) but the call never connects.
      mockAnswer.mockResolvedValue(undefined);

      const { useCallService } = await import('./call-service');
      void useCallService().answerCall();
      await vi.advanceTimersByTimeAsync(0);

      // Keep status stuck at connecting so the watchdog fires.
      (mockCallStore.activeCall as { status: string }).status = 'connecting';
      await vi.advanceTimersByTimeAsync(30_000);

      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ICE candidates held until the remote description (O15)', () => {
  /**
   * The SDK adds the candidates it buffered while ringing before it sets the
   * answer; the buffer attached in onPeerConnectionCreated is what keeps
   * them. The mocked SDK never emits PeerConnectionCreated, so this goes
   * through the 300 ms fallback that watches `call.peerConn`.
   */
  it('attaches the candidate buffer to the peer connection the SDK creates', async () => {
    const pc = {
      remoteDescription: null as RTCSessionDescriptionInit | null,
      signalingState: 'have-local-offer',
      iceConnectionState: 'new',
      iceGatheringState: 'new',
      connectionState: 'new',
      oniceconnectionstatechange: null,
      onsignalingstatechange: null,
      onconnectionstatechange: null,
      onicecandidate: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getStats: vi.fn(async () => new Map()),
      restartIce: vi.fn(),
      close: vi.fn(),
      addIceCandidate: vi.fn(async (_candidate?: RTCIceCandidateInit) => {}),
      setRemoteDescription: vi.fn(async (d: RTCSessionDescriptionInit) => {
        pc.remoteDescription = d;
      }),
    };
    const originalAdd = pc.addIceCandidate;
    const fakeCall = {
      callId: 'ice-call-id',
      roomId: 'test-room-id',
      type: 'voice',
      on: mockOn,
      off: mockOff,
      placeVoiceCall: mockPlaceVoiceCall,
      placeVideoCall: mockPlaceVideoCall,
      answer: mockAnswer,
      reject: mockReject,
      hangup: mockHangup,
      isMicrophoneMuted: vi.fn(() => false),
      localUsermediaStream: null,
      localScreensharingStream: null,
      remoteUsermediaStream: null,
      remoteScreensharingStream: null,
      remoteUsermediaFeed: null,
      getOpponentMember: vi.fn(() => ({ userId: '@peer:matrix.org' })),
      peerConn: pc,
    };
    const { createNewMatrixCall } = await import('matrix-js-sdk-bastyon/lib/webrtc/call');
    vi.mocked(createNewMatrixCall).mockReturnValueOnce(fakeCall as never);

    vi.useFakeTimers();
    try {
      const { useCallService } = await import('./call-service');
      void useCallService().startCall('!room:matrix.org', 'voice');
      await vi.advanceTimersByTimeAsync(0);
      // The fallback poll runs every 300 ms.
      await vi.advanceTimersByTimeAsync(300);

      expect((pc as unknown as Record<string, unknown>).__iceCandidateBufferAttached).toBe(true);
      await pc.addIceCandidate({ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 });
      expect(originalAdd).not.toHaveBeenCalled();
      await pc.setRemoteDescription({ type: 'answer', sdp: 'v=0' });
      expect(originalAdd).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('call events retried through a short network outage', () => {
  /**
   * The SDK ends the call when one send of the restart offer fails; the retry
   * wrapper keeps it going (voip-send-retry.ts). It has to be installed on
   * every call call-service wires, or a restart during a network change still
   * ends the call (Samsung `wifioff-vpn2`).
   */
  it('retries a restart offer that failed for lack of a connection on a placed call', async () => {
    class ConnectionError extends Error {
      get name(): string { return 'ConnectionError'; }
    }
    const send = vi.fn(async (_type: string, _content: Record<string, unknown>) => {});
    send.mockRejectedValueOnce(new ConnectionError('fetch failed'));
    const fakeCall = {
      callId: 'retry-call-id',
      roomId: 'test-room-id',
      type: 'voice',
      on: mockOn,
      off: mockOff,
      placeVoiceCall: mockPlaceVoiceCall,
      placeVideoCall: mockPlaceVideoCall,
      answer: mockAnswer,
      reject: mockReject,
      hangup: mockHangup,
      isMicrophoneMuted: vi.fn(() => false),
      localUsermediaStream: null,
      localScreensharingStream: null,
      remoteUsermediaStream: null,
      remoteScreensharingStream: null,
      remoteUsermediaFeed: null,
      getOpponentMember: vi.fn(() => ({ userId: '@peer:matrix.org' })),
      sendVoipEvent: send,
      callHasEnded: () => false,
    };
    const { createNewMatrixCall } = await import('matrix-js-sdk-bastyon/lib/webrtc/call');
    vi.mocked(createNewMatrixCall).mockReturnValueOnce(fakeCall as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.useFakeTimers();
    try {
      const { useCallService } = await import('./call-service');
      void useCallService().startCall('!room:matrix.org', 'voice');
      await vi.advanceTimersByTimeAsync(0);

      const sent = fakeCall.sendVoipEvent('m.call.negotiate', { description: {} });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(sent).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Tor hint and the no-relay warning (O05/O14)', () => {
  beforeEach(() => {
    torState.isEnabled = false;
    torState.isConnected = false;
    toastSpy.mockClear();
  });

  it('says that the call bypasses Tor when Tor is enabled, once per placed call', async () => {
    torState.isEnabled = true;
    const { useCallService } = await import('./call-service');
    await useCallService().startCall('!room:matrix.org', 'voice');
    await new Promise((r) => setTimeout(r, 0));

    const torHints = toastSpy.mock.calls.filter((c) => /Tor/.test(String(c[0])));
    expect(torHints).toHaveLength(1);
    expect(torHints[0][1]).toBe('info');
  });

  it('stays quiet about Tor when it is off', async () => {
    const { useCallService } = await import('./call-service');
    await useCallService().startCall('!room:matrix.org', 'voice');
    await new Promise((r) => setTimeout(r, 0));

    expect(toastSpy.mock.calls.filter((c) => /Tor/.test(String(c[0])))).toHaveLength(0);
  });

  it('turns the diagnostics no-relay warning into a toast', async () => {
    const pc = {
      remoteDescription: null as RTCSessionDescriptionInit | null,
      signalingState: 'have-local-offer',
      iceConnectionState: 'new',
      iceGatheringState: 'new',
      connectionState: 'new',
      oniceconnectionstatechange: null,
      onsignalingstatechange: null,
      onconnectionstatechange: null,
      onicecandidate: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getStats: vi.fn(async () => new Map()),
      restartIce: vi.fn(),
      close: vi.fn(),
      addIceCandidate: vi.fn(async (_candidate?: RTCIceCandidateInit) => {}),
      setRemoteDescription: vi.fn(async (d: RTCSessionDescriptionInit) => {
        pc.remoteDescription = d;
      }),
    };
    const fakeCall = {
      callId: 'relay-call-id',
      roomId: 'test-room-id',
      type: 'voice',
      on: mockOn,
      off: mockOff,
      placeVoiceCall: mockPlaceVoiceCall,
      placeVideoCall: mockPlaceVideoCall,
      answer: mockAnswer,
      reject: mockReject,
      hangup: mockHangup,
      isMicrophoneMuted: vi.fn(() => false),
      localUsermediaStream: null,
      localScreensharingStream: null,
      remoteUsermediaStream: null,
      remoteScreensharingStream: null,
      remoteUsermediaFeed: null,
      getOpponentMember: vi.fn(() => ({ userId: '@peer:matrix.org' })),
      peerConn: pc,
    };
    const { createNewMatrixCall } = await import('matrix-js-sdk-bastyon/lib/webrtc/call');
    vi.mocked(createNewMatrixCall).mockReturnValueOnce(fakeCall as never);
    const { webrtcDiagnostics } = await import('./webrtc-diagnostics');

    vi.useFakeTimers();
    try {
      const { useCallService } = await import('./call-service');
      void useCallService().startCall('!room:matrix.org', 'voice');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(300);

      webrtcDiagnostics.dispatchEvent(
        new CustomEvent('warning', { detail: { type: 'ice_failed_no_relay' } }),
      );
      const relayToasts = toastSpy.mock.calls.filter((c) => /relay/i.test(String(c[0])));
      expect(relayToasts).toHaveLength(1);
    } finally {
      webrtcDiagnostics.detach();
      vi.useRealTimers();
    }
  });
});

describe('remote video state reaches the native call screen', () => {
  // The native call screen hides the remote picture while JS reports the
  // remote camera muted, and has no other source for that state. With the
  // native engine every remote track arrives as its own event: the SDK builds
  // the feed from the audio track alone, so isVideoMuted() reads true at that
  // moment, and the video track joins the same stream a moment later. The
  // screen only ever heard the first answer and kept the avatar over live
  // frames for the whole call.
  beforeEach(async () => {
    // 'onAudioError listener' above re-mocks the bridge with untracked spies
    // and resets the module cache; point call-service back at the tracked
    // methods so the screen updates below are observable.
    vi.doMock('@/shared/lib/native-webrtc', () => ({
      installNativeWebRTCProxy: vi.fn(),
      isNativeWebRTCEngineEnabled: () => true,
      NativeWebRTC: new Proxy({}, {
        get: (_target, prop) =>
          typeof prop === 'string' && prop in mockNativeWebRTCMethods
            ? mockNativeWebRTCMethods[prop]
            : vi.fn().mockResolvedValue({}),
      }),
    }));
    vi.resetModules();
    vi.useRealTimers();
    vi.clearAllMocks();
    mockCallStore.isInCall = false;
    mockCallStore.activeCall = null;
    mockCallStore.matrixCall = null;
    mockCallStore.remoteVideoMuted = false;
    mockEnsureCallPermissions.mockResolvedValue(undefined);
    mockGetUser.mockReset();
    mockGetUser.mockReturnValue({ name: 'Peer' });
    mockLoadUsersBatch.mockReset();
    mockLoadUsersBatch.mockResolvedValue(undefined);
    const { __resetFinalizeCallStateForTests } = await import('./finalize-call');
    __resetFinalizeCallStateForTests();
  });

  type Listener = (...args: unknown[]) => void;

  /** CallFeed stub: as in the SDK, isVideoMuted() is true while the stream has no video track. */
  function makeRemoteFeed() {
    const listeners = new Map<string, Set<Listener>>();
    const kinds = ['audio'];
    return {
      isVideoMuted: () => !kinds.includes('video'),
      on: (event: string, fn: Listener) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)?.add(fn);
      },
      off: (event: string, fn: Listener) => {
        listeners.get(event)?.delete(fn);
      },
      emit: (event: string, ...args: unknown[]) => {
        listeners.get(event)?.forEach((fn) => fn(...args));
      },
      listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
      addVideoTrack: () => {
        kinds.push('video');
      },
    };
  }

  let seq = 0;

  /**
   * Rings an incoming video call. The call carries its own on/off spies, so
   * its handlers are read from it and a missing one fails the test instead of
   * turning the step into a silent no-op.
   */
  async function ringIncomingVideoCall() {
    const on = vi.fn();
    const off = vi.fn();
    const call: Record<string, unknown> = {
      callId: `remote-video-${++seq}`,
      roomId: '!room:matrix.org',
      type: 'video',
      state: 'ringing',
      on,
      off,
      answer: mockAnswer,
      reject: mockReject,
      hangup: mockHangup,
      isMicrophoneMuted: vi.fn(() => false),
      localUsermediaStream: null,
      localScreensharingStream: null,
      remoteUsermediaStream: null,
      remoteScreensharingStream: null,
      remoteUsermediaFeed: null,
      getOpponentMember: vi.fn(() => ({ userId: '@peer:matrix.org' })),
    };
    const { useCallService } = await import('./call-service');
    const { __resetIncomingCallDedupForTests } = await import('./incoming-call-dedup');
    __resetIncomingCallDedupForTests();
    mockCallStore.matrixCall = call;
    await useCallService().handleIncomingCall(call as never);
    const handler = (event: string) => {
      const entry = on.mock.calls.find((c: unknown[]) => c[0] === event);
      if (!entry) throw new Error(`no ${event} handler wired`);
      return entry[1] as (...args: unknown[]) => void;
    };
    return { call, handler };
  }

  /** The muted values the native screen received, in order. */
  function screenStates(): boolean[] {
    return mockNativeWebRTCMethods.updateRemoteVideoState.mock.calls.map(
      (c: unknown[]) => (c[0] as { muted: boolean }).muted,
    );
  }

  it('shows the remote picture once the video track joins the feed', async () => {
    const { call, handler } = await ringIncomingVideoCall();
    const feed = makeRemoteFeed();
    call.remoteUsermediaFeed = feed;
    handler('FeedsChanged')();
    expect(screenStates()).toEqual([true]);

    feed.addVideoTrack();
    feed.emit('new_stream');

    expect(screenStates()).toEqual([true, false]);
    expect(mockCallStore.remoteVideoMuted).toBe(false);
  });

  it('tells the screen when a later refresh of the same feed finds the video track', async () => {
    const { call, handler } = await ringIncomingVideoCall();
    const feed = makeRemoteFeed();
    call.remoteUsermediaFeed = feed;
    handler('FeedsChanged')();

    feed.addVideoTrack();
    handler('FeedsChanged')();

    expect(screenStates()).toEqual([true, false]);
  });

  it('does not repeat an unchanged state to the screen', async () => {
    const { call, handler } = await ringIncomingVideoCall();
    const feed = makeRemoteFeed();
    call.remoteUsermediaFeed = feed;
    handler('FeedsChanged')();

    feed.emit('new_stream');
    handler('FeedsChanged')();

    expect(screenStates()).toEqual([true]);
  });

  it('stops listening to the feed when the call ends', async () => {
    const { call, handler } = await ringIncomingVideoCall();
    const feed = makeRemoteFeed();
    call.remoteUsermediaFeed = feed;
    handler('FeedsChanged')();
    expect(feed.listenerCount('new_stream')).toBe(1);

    handler('State')('ended', 'connected');

    expect(feed.listenerCount('new_stream')).toBe(0);
    expect(feed.listenerCount('mute_state_changed')).toBe(0);
  });
});
