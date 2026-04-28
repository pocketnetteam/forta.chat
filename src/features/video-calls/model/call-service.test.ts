import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing call-service
// ---------------------------------------------------------------------------

// Mock platform
vi.mock('@/shared/lib/platform', () => ({
  isNative: true,
  isAndroid: true,
  isIOS: false,
  isElectron: false,
  isWeb: false,
  currentPlatform: 'android',
}));

// Mock Capacitor core
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
  },
  registerPlugin: () => new Proxy({}, {
    get: () => vi.fn().mockResolvedValue({}),
  }),
}));

// Track addListener calls on NativeWebRTC
const mockAddListener = vi.fn().mockResolvedValue({ remove: vi.fn() });
const mockNativeWebRTCMethods: Record<string, Mock> = {
  addListener: mockAddListener,
  launchCallUI: vi.fn().mockResolvedValue({}),
  dismissCallUI: vi.fn().mockResolvedValue({}),
  updateCallStatus: vi.fn().mockResolvedValue({}),
  updateRemoteVideoState: vi.fn().mockResolvedValue({}),
  startLocalMedia: vi.fn().mockResolvedValue({}),
};

vi.mock('@/shared/lib/native-webrtc', () => ({
  installNativeWebRTCProxy: vi.fn(),
  NativeWebRTC: new Proxy({}, {
    get: (_target, prop) => {
      if (typeof prop === 'string' && prop in mockNativeWebRTCMethods) {
        return mockNativeWebRTCMethods[prop];
      }
      return vi.fn().mockResolvedValue({});
    },
  }),
}));

// Mock native-call-bridge
const mockRequestAudioPermission = vi.fn();
const mockRequestCameraPermission = vi.fn();
const mockStartAudioRouting = vi.fn().mockResolvedValue(undefined);
const mockStopAudioRouting = vi.fn().mockResolvedValue(undefined);
vi.mock('@/shared/lib/native-calls', () => ({
  nativeCallBridge: {
    requestAudioPermission: mockRequestAudioPermission,
    requestCameraPermission: mockRequestCameraPermission,
    reportOutgoingCall: vi.fn().mockResolvedValue(undefined),
    reportCallConnected: vi.fn().mockResolvedValue(undefined),
    reportCallEnded: vi.fn().mockResolvedValue(undefined),
    reportIncomingCall: vi.fn().mockResolvedValue(undefined),
    wire: vi.fn().mockResolvedValue(undefined),
    startAudioRouting: mockStartAudioRouting,
    stopAudioRouting: mockStopAudioRouting,
  },
  consumePendingAnswerCallId: vi.fn().mockResolvedValue(false),
  consumePendingRejectCallId: vi.fn().mockResolvedValue(false),
}));

// Mock permissions — by default resolves ok; individual tests override via
// mockEnsureCallPermissions.mockRejectedValueOnce(...) when denied paths
// need to be exercised. This lets call-service tests focus on the flow
// around ensureCallPermissions, not its internals (covered in permissions.test.ts).
class MockPermissionDeniedError extends Error {
  constructor(public readonly device: 'microphone' | 'camera') {
    super(`Permission denied: ${device}`);
    this.name = 'PermissionDeniedError';
  }
}
const mockEnsureCallPermissions = vi.fn();
const mockCallPermissionError: { value: { device: 'microphone' | 'camera' } | null } = { value: null };
vi.mock('./permissions', () => ({
  ensureCallPermissions: mockEnsureCallPermissions,
  PermissionDeniedError: MockPermissionDeniedError,
  callPermissionError: mockCallPermissionError,
  clearCallPermissionError: () => {
    mockCallPermissionError.value = null;
  },
}));

// Mock call store — shared object so property assignments persist across calls
const mockUpdateStatus = vi.fn();
const mockScheduleClearCall = vi.fn();
const mockCancelScheduledClear = vi.fn();
const mockSetActiveCall = vi.fn();
const mockSetMatrixCall = vi.fn();
const mockAddHistoryEntry = vi.fn();

const mockCallStore: Record<string, unknown> = {
  isInCall: false,
  activeCall: null,
  matrixCall: null,
  videoMuted: false,
  audioMuted: false,
  callTimer: 0,
  remoteVideoMuted: false,
  remoteScreenSharing: false,
  screenSharing: false,
  updateStatus: mockUpdateStatus,
  scheduleClearCall: mockScheduleClearCall,
  cancelScheduledClear: mockCancelScheduledClear,
  setActiveCall: mockSetActiveCall,
  setMatrixCall: mockSetMatrixCall,
  addHistoryEntry: mockAddHistoryEntry,
  setLocalStream: vi.fn(),
  setLocalScreenStream: vi.fn(),
  setRemoteStream: vi.fn(),
  setRemoteScreenStream: vi.fn(),
  startTimer: vi.fn(),
  stopTimer: vi.fn(),
  clearCall: vi.fn(),
};

vi.mock('@/entities/call', () => ({
  useCallStore: () => mockCallStore,
  CallStatus: {
    idle: 'idle',
    incoming: 'incoming',
    ringing: 'ringing',
    connecting: 'connecting',
    connected: 'connected',
    ended: 'ended',
    failed: 'failed',
  },
}));

// Mock Matrix SDK
const mockPlaceVoiceCall = vi.fn().mockResolvedValue(undefined);
const mockPlaceVideoCall = vi.fn().mockResolvedValue(undefined);
const mockAnswer = vi.fn().mockResolvedValue(undefined);
const mockReject = vi.fn();
const mockHangup = vi.fn();
const mockOn = vi.fn();
const mockOff = vi.fn();

vi.mock('matrix-js-sdk-bastyon/lib/webrtc/call', () => ({
  createNewMatrixCall: vi.fn(() => ({
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
    localUsermediaStream: null,
    localScreensharingStream: null,
    remoteUsermediaStream: null,
    remoteScreensharingStream: null,
    remoteUsermediaFeed: null,
    getOpponentMember: vi.fn(() => ({ userId: '@peer:matrix.org' })),
  })),
  CallEvent: {
    State: 'State',
    FeedsChanged: 'FeedsChanged',
    Hangup: 'Hangup',
    Error: 'Error',
  },
  CallState: {
    Ringing: 'ringing',
    Connecting: 'connecting',
    Connected: 'connected',
    Ended: 'ended',
    CreateOffer: 'create_offer',
    CreateAnswer: 'create_answer',
    InviteSent: 'invite_sent',
    WaitLocalMedia: 'wait_local_media',
  },
  CallErrorCode: {
    UserHangup: 'user_hangup',
  },
}));

// Mock matrix client service
vi.mock('@/entities/matrix', () => ({
  getMatrixClientService: vi.fn(() => ({
    client: {
      getRoom: vi.fn(() => ({
        getJoinedMembers: () => [
          { userId: '@me:matrix.org' },
          { userId: '@peer:matrix.org' },
        ],
      })),
      supportsVoip: vi.fn(() => true),
      getMediaHandler: vi.fn(() => ({
        restoreMediaSettings: vi.fn(),
      })),
    },
    getUserId: vi.fn(() => '@me:matrix.org'),
  })),
}));

vi.mock('@/entities/user', () => ({
  useUserStore: () => ({
    loadUserIfMissing: vi.fn(),
    getUser: vi.fn(() => ({ name: 'Peer' })),
  }),
}));

vi.mock('@/entities/chat/lib/chat-helpers', () => ({
  matrixIdToAddress: vi.fn((id: string) => id),
}));

vi.mock('./call-sounds', () => ({
  playRingtone: vi.fn(),
  playDialtone: vi.fn(),
  playEndTone: vi.fn(),
  stopAllSounds: vi.fn(),
}));

vi.mock('./call-tab-lock', () => ({
  checkOtherTabHasCall: vi.fn().mockResolvedValue(false),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('call-service permission flow', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset shared mock store state
    mockCallStore.isInCall = false;
    mockCallStore.activeCall = null;
    mockCallStore.matrixCall = null;
    mockCallStore.videoMuted = false;
    // Default: permissions resolve successfully. Individual tests override
    // with mockRejectedValueOnce(new MockPermissionDeniedError(...)).
    mockEnsureCallPermissions.mockResolvedValue(undefined);
    // Clear finalize-call's per-callId idempotency map between tests —
    // many tests reuse the same callId ('test-call-id', 'incoming-call-id'),
    // and a leftover finalized entry would short-circuit the cleanup
    // chain on the next run.
    const { __resetFinalizeCallStateForTests } = await import('./finalize-call');
    __resetFinalizeCallStateForTests();
  });

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
  });

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

  describe('audio routing lifecycle (AudioRouter wiring)', () => {
    beforeEach(() => {
      mockStartAudioRouting.mockClear();
      mockStopAudioRouting.mockClear();
    });

    it('calls startAudioRouting after placeVoiceCall with callType=voice', async () => {
      mockRequestAudioPermission.mockResolvedValue({ granted: true });

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      expect(mockPlaceVoiceCall).toHaveBeenCalledOnce();
      expect(mockStartAudioRouting).toHaveBeenCalledWith({ callType: 'voice' });
    });

    it('calls startAudioRouting after placeVideoCall with callType=video', async () => {
      mockRequestAudioPermission.mockResolvedValue({ granted: true });

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'video');

      expect(mockPlaceVideoCall).toHaveBeenCalledOnce();
      expect(mockStartAudioRouting).toHaveBeenCalledWith({ callType: 'video' });
    });

    it('does NOT call startAudioRouting when placeCall throws', async () => {
      mockRequestAudioPermission.mockResolvedValue({ granted: true });
      mockPlaceVoiceCall.mockRejectedValueOnce(new Error('fail'));

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      expect(mockStartAudioRouting).not.toHaveBeenCalled();
    });

    it('does NOT reject the call if startAudioRouting fails (graceful degradation)', async () => {
      mockRequestAudioPermission.mockResolvedValue({ granted: true });
      mockStartAudioRouting.mockRejectedValueOnce(new Error('router failed'));

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      // Place call still succeeded, no failed status was set due to routing error
      expect(mockPlaceVoiceCall).toHaveBeenCalledOnce();
      // updateStatus should NOT have been called with 'failed' because of routing
      const failedCalls = mockUpdateStatus.mock.calls.filter(
        (args) => args[0] === 'failed'
      );
      expect(failedCalls).toHaveLength(0);
    });

    it('calls startAudioRouting after answering incoming call', async () => {
      mockRequestAudioPermission.mockResolvedValue({ granted: true });

      mockCallStore.matrixCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type: 'voice',
        on: mockOn,
        off: mockOff,
        answer: mockAnswer,
        localUsermediaStream: null,
        localScreensharingStream: null,
        remoteUsermediaStream: null,
        remoteScreensharingStream: null,
        remoteUsermediaFeed: null,
      };
      mockCallStore.activeCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type: 'voice',
        direction: 'incoming',
        peerName: 'Peer',
        status: 'incoming',
      };

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();

      expect(mockAnswer).toHaveBeenCalledOnce();
      expect(mockStartAudioRouting).toHaveBeenCalledWith({ callType: 'voice' });
    });

    it('calls stopAudioRouting on hangup', async () => {
      mockCallStore.matrixCall = {
        callId: 'test-call-id',
        on: mockOn,
        off: mockOff,
        hangup: mockHangup,
      };

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      service.hangup();

      expect(mockHangup).toHaveBeenCalledOnce();
      expect(mockStopAudioRouting).toHaveBeenCalledOnce();
    });

    it('calls stopAudioRouting on rejectCall', async () => {
      mockCallStore.matrixCall = {
        callId: 'test-call-id',
        on: mockOn,
        off: mockOff,
        reject: mockReject,
      };
      mockCallStore.activeCall = {
        callId: 'test-call-id',
        roomId: '!room:matrix.org',
        peerId: '@peer:matrix.org',
        peerName: 'Peer',
        type: 'voice',
        direction: 'incoming',
      };

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      service.rejectCall();

      expect(mockReject).toHaveBeenCalledOnce();
      expect(mockStopAudioRouting).toHaveBeenCalledOnce();
    });

    it('does not throw when stopAudioRouting fails', async () => {
      mockStopAudioRouting.mockRejectedValueOnce(new Error('stop failed'));
      mockCallStore.matrixCall = {
        callId: 'test-call-id',
        on: mockOn,
        off: mockOff,
        hangup: mockHangup,
      };

      const { useCallService } = await import('./call-service');
      const service = useCallService();

      expect(() => service.hangup()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Session 01 / H1 + H7: audioRouter lifecycle must be idempotent on error.
  //
  // Before this fix, when `call.answer()` threw inside answerCall (OEM audio
  // deadlock, BT routing conflict with CallActivity's duplicate AudioRouter),
  // the catch block did NOT call stopAudioRouting. MODE_IN_COMMUNICATION would
  // stay set, BT SCO would remain held, and the device's earpiece could be
  // stuck in "phone call" state until reboot. Symmetric problem on startCall
  // when placeVoiceCall/placeVideoCall throws.
  //
  // The fix: catch block (or finally equivalent) always calls stopAudioRouting.
  // Native side is idempotent, so a no-op stop is safe even if start was never
  // reached. This closes the #442/#443/#408 class of bugs where the mic or
  // earpiece gets stuck between calls.
  // -------------------------------------------------------------------------
  describe('audioRouter lifecycle on error (H1/H7)', () => {
    beforeEach(() => {
      mockStartAudioRouting.mockClear();
      mockStopAudioRouting.mockClear();
    });

    it('calls stopAudioRouting in catch when call.answer() throws', async () => {
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
      };
      mockCallStore.activeCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type: 'voice',
        direction: 'incoming',
        peerName: 'Peer',
        status: 'incoming',
      };
      mockAnswer.mockRejectedValueOnce(new Error('SDK answer deadlock'));

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();

      expect(mockStopAudioRouting).toHaveBeenCalled();
    });

    it('calls stopAudioRouting in catch when placeVoiceCall throws', async () => {
      mockPlaceVoiceCall.mockRejectedValueOnce(new Error('place failed'));

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      expect(mockStopAudioRouting).toHaveBeenCalled();
    });

    it('calls stopAudioRouting in catch when placeVideoCall throws', async () => {
      mockPlaceVideoCall.mockRejectedValueOnce(new Error('place failed'));

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'video');

      expect(mockStopAudioRouting).toHaveBeenCalled();
    });

    it('does not throw even if stopAudioRouting itself rejects during catch', async () => {
      mockAnswer.mockRejectedValueOnce(new Error('answer failed'));
      mockStopAudioRouting.mockRejectedValueOnce(new Error('stop failed'));
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
      };
      mockCallStore.activeCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type: 'voice',
        direction: 'incoming',
        peerName: 'Peer',
        status: 'incoming',
      };

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      // Must not propagate the stopAudioRouting error to the caller —
      // UI layer can't recover from a routing cleanup failure anyway.
      await expect(service.answerCall()).resolves.toBeUndefined();
    });
  });

  describe('onAudioError listener', () => {
    it('registers onAudioError listener on module load for native', async () => {
      // Module-level code runs once at first import. Since vi.clearAllMocks()
      // clears call history, we need to re-import with a fresh module.
      vi.resetModules();
      // Re-create the addListener mock since resetModules clears module cache
      const freshAddListener = vi.fn().mockResolvedValue({ remove: vi.fn() });
      vi.doMock('@/shared/lib/native-webrtc', () => ({
        installNativeWebRTCProxy: vi.fn(),
        NativeWebRTC: new Proxy({}, {
          get: (_target, prop) => {
            if (prop === 'addListener') return freshAddListener;
            return vi.fn().mockResolvedValue({});
          },
        }),
      }));

      await import('./call-service');

      const audioErrorCall = freshAddListener.mock.calls.find(
        (call: unknown[]) => call[0] === 'onAudioError'
      );
      expect(audioErrorCall).toBeTruthy();
    });
  });
});
