import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

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
const mockStartAudioRouting = vi.fn().mockResolvedValue(undefined);
const mockStopAudioRouting = vi.fn().mockResolvedValue(undefined);
vi.mock('@/shared/lib/native-calls', () => ({
  nativeCallBridge: {
    requestAudioPermission: mockRequestAudioPermission,
    reportOutgoingCall: vi.fn().mockResolvedValue(undefined),
    reportCallConnected: vi.fn().mockResolvedValue(undefined),
    reportCallEnded: vi.fn().mockResolvedValue(undefined),
    reportIncomingCall: vi.fn().mockResolvedValue(undefined),
    wire: vi.fn().mockResolvedValue(undefined),
    startAudioRouting: mockStartAudioRouting,
    stopAudioRouting: mockStopAudioRouting,
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
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset shared mock store state
    mockCallStore.isInCall = false;
    mockCallStore.activeCall = null;
    mockCallStore.matrixCall = null;
    mockCallStore.videoMuted = false;
  });

  describe('startCall', () => {
    it('calls requestAudioPermission before creating MatrixCall on native', async () => {
      mockRequestAudioPermission.mockResolvedValue({ granted: true });

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      expect(mockRequestAudioPermission).toHaveBeenCalledOnce();
    });

    it('sets CallStatus.failed and returns early when permission denied', async () => {
      mockRequestAudioPermission.mockResolvedValue({ granted: false });

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      expect(mockUpdateStatus).toHaveBeenCalledWith('failed');
      expect(mockScheduleClearCall).toHaveBeenCalledWith(1500);
      expect(mockPlaceVoiceCall).not.toHaveBeenCalled();
    });
  });

  describe('answerCall', () => {
    it('calls requestAudioPermission before answering on native', async () => {
      mockRequestAudioPermission.mockResolvedValue({ granted: true });

      // Simulate incoming call state on shared mock store
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

      expect(mockRequestAudioPermission).toHaveBeenCalledOnce();
    });

    it('sets CallStatus.failed when permission denied on answer', async () => {
      mockRequestAudioPermission.mockResolvedValue({ granted: false });

      mockCallStore.matrixCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type: 'voice',
        on: mockOn,
        off: mockOff,
        answer: mockAnswer,
        localUsermediaStream: null,
      };
      mockCallStore.activeCall = {
        callId: 'incoming-call-id',
        type: 'voice',
        direction: 'incoming',
        peerName: 'Peer',
        status: 'incoming',
      };

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();

      expect(mockUpdateStatus).toHaveBeenCalledWith('failed');
      expect(mockScheduleClearCall).toHaveBeenCalledWith(1500);
      expect(mockAnswer).not.toHaveBeenCalled();
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
