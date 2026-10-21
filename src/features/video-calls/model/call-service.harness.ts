// Shared mocks for the call-service test files, split out of call-service.test.ts. Import it before
// anything else: its vi.mock calls must be registered before a test imports './call-service'.
import { vi, type Mock } from 'vitest';
import { reactive, ref } from 'vue';

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
export const mockAddListener = vi.fn().mockResolvedValue({ remove: vi.fn() });
export const mockNativeWebRTCMethods: Record<string, Mock> = {
  addListener: mockAddListener,
  launchCallUI: vi.fn().mockResolvedValue({}),
  dismissCallUI: vi.fn().mockResolvedValue({}),
  updateCallStatus: vi.fn().mockResolvedValue({}),
  updateRemoteVideoState: vi.fn().mockResolvedValue({}),
  startLocalMedia: vi.fn().mockResolvedValue({}),
};

vi.mock('@/shared/lib/native-webrtc', () => ({
  installNativeWebRTCProxy: vi.fn(),
  isNativeWebRTCEngineEnabled: () => true,
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
export const mockRequestAudioPermission = vi.fn();
export const mockRequestCameraPermission = vi.fn();
export const mockStartAudioRouting = vi.fn().mockResolvedValue(undefined);
export const mockStopAudioRouting = vi.fn().mockResolvedValue(undefined);
export const mockEnsureIncomingCallVisible = vi.fn().mockResolvedValue(undefined);
export const mockReportCallEnded = vi.fn().mockResolvedValue(undefined);
vi.mock('@/shared/lib/native-calls', () => ({
  nativeCallBridge: {
    requestAudioPermission: mockRequestAudioPermission,
    requestCameraPermission: mockRequestCameraPermission,
    reportOutgoingCall: vi.fn().mockResolvedValue(undefined),
    reportCallConnected: vi.fn().mockResolvedValue(undefined),
    reportCallEnded: mockReportCallEnded,
    reportIncomingCall: vi.fn().mockResolvedValue(undefined),
    wire: vi.fn().mockResolvedValue(undefined),
    startAudioRouting: mockStartAudioRouting,
    stopAudioRouting: mockStopAudioRouting,
    ensureIncomingCallVisible: mockEnsureIncomingCallVisible,
  },
  consumePendingAnswerCallId: vi.fn().mockResolvedValue(false),
  consumePendingRejectCallId: vi.fn().mockResolvedValue(false),
  retirePendingMarkers: vi.fn().mockResolvedValue(undefined),
}));

// Mock permissions — by default resolves ok; individual tests override via
// mockEnsureCallPermissions.mockRejectedValueOnce(...) when denied paths
// need to be exercised. This lets call-service tests focus on the flow
// around ensureCallPermissions, not its internals (covered in permissions.test.ts).
export class MockPermissionDeniedError extends Error {
  constructor(public readonly device: 'microphone' | 'camera') {
    super(`Permission denied: ${device}`);
    this.name = 'PermissionDeniedError';
  }
}
export const mockEnsureCallPermissions = vi.fn();
export const mockCallPermissionError: { value: { device: 'microphone' | 'camera' } | null } = { value: null };
vi.mock('./permissions', () => ({
  ensureCallPermissions: mockEnsureCallPermissions,
  PermissionDeniedError: MockPermissionDeniedError,
  callPermissionError: mockCallPermissionError,
  clearCallPermissionError: () => {
    mockCallPermissionError.value = null;
  },
}));

// Mock call store — shared object so property assignments persist across calls
export const mockUpdateStatus = vi.fn();
export const mockScheduleClearCall = vi.fn();
export const mockCancelScheduledClear = vi.fn();
export const mockSetActiveCall = vi.fn();
export const mockSetMatrixCall = vi.fn();
export const mockAddHistoryEntry = vi.fn();

export const mockCallStore: Record<string, unknown> = {
  isInCall: false,
  hasLiveCall: false,
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
  touchMatrixCall: vi.fn(),
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
export const mockPlaceVoiceCall = vi.fn().mockResolvedValue(undefined);
export const mockPlaceVideoCall = vi.fn().mockResolvedValue(undefined);
export const mockAnswer = vi.fn().mockResolvedValue(undefined);
export const mockReject = vi.fn();
export const mockHangup = vi.fn();
export const mockOn = vi.fn();
export const mockOff = vi.fn();

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
    state: 'create_offer',
    callHasEnded: vi.fn(() => false),
  })),
  CallEvent: {
    State: 'State',
    FeedsChanged: 'FeedsChanged',
    Hangup: 'Hangup',
    Error: 'Error',
    Replaced: 'Replaced',
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
    NoUserMedia: 'no_user_media',
  },
}));

// Mock matrix client service. The client sits in a mutable holder so a test
// can take it away (`matrixState.client = null`) — the state a dial finds
// right after a cold start, before Matrix has connected.
export function makeMockClient() {
  return {
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
  };
}
export const matrixState: { client: ReturnType<typeof makeMockClient> | null } = {
  client: makeMockClient(),
};
vi.mock('@/entities/matrix', () => ({
  getMatrixClientService: vi.fn(() => ({
    get client() {
      return matrixState.client;
    },
    getUserId: vi.fn(() => '@me:matrix.org'),
  })),
}));

// The auth store is read lazily by the dial path for `matrixReady`; a reactive
// holder lets a test flip readiness mid-wait the way the real store does.
export const authState = reactive({ matrixReady: true });
vi.mock('@/entities/auth', () => ({
  useAuthStore: () => authState,
}));

// Hoisted user-store mock so individual tests can stage cold-cache and
// late-arriving-profile scenarios for resolvePeerInfo. Default behaviour
// matches the pre-Session-30 contract: profile is already cached, no
// network round-trip needed. Tests that exercise the timeout/late-update
// path call `mockGetUser.mockReturnValueOnce(undefined)` to force a miss
// and then resolve `mockLoadUsersBatch` to simulate the network reply.
export const mockLoadUsersBatch = vi.fn().mockResolvedValue(undefined);
// Explicit return-type union so individual tests can return undefined to
// simulate a cold cache miss without TS rejecting the override. The real
// userStore.getUser signature is also nullable.
export const mockGetUser = vi.fn<(addr: string) => { name: string } | undefined>(
  () => ({ name: 'Peer' }),
);
vi.mock('@/entities/user', () => ({
  useUserStore: () => ({
    loadUserIfMissing: vi.fn(),
    loadUsersBatch: mockLoadUsersBatch,
    getUser: mockGetUser,
  }),
}));

vi.mock('@/entities/chat/lib/chat-helpers', () => ({
  matrixIdToAddress: vi.fn((id: string) => id),
}));

// O14: the Tor store is imported lazily by call-service; the mock is
// mutable so a test can turn Tor on. The toast is spied so the Tor hint and
// the diagnostics warnings can be asserted.
export const torState = { isEnabled: false, isConnected: false };
vi.mock('@/entities/tor', () => ({
  useTorStore: () => torState,
}));
// One global toast slot, like the real composable: `message` holds whatever
// was shown last, so a test can stage an unrelated toast during a wait.
export const toastMessage = ref('');
export const toastSpy = vi.fn((msg: string, _type?: string, _duration?: number) => {
  toastMessage.value = msg;
});
export const toastCloseSpy = vi.fn();
vi.mock('@/shared/lib/use-toast', () => ({
  useToast: () => ({ message: toastMessage, toast: toastSpy, close: toastCloseSpy }),
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

// The page-awake tone keeps Chromium from freezing the page while the native
// call screen hides it; these tests only check which call holds it, and when.
export const mockHoldPageAwake = vi.fn();
vi.mock('./page-awake-tone', () => ({
  holdPageAwake: mockHoldPageAwake,
  releasePageAwake: vi.fn(),
}));

/** The reset every call-service suite runs before each test. */
export async function resetCallServiceHarness(): Promise<void> {
  vi.useRealTimers();
  vi.clearAllMocks();
  // Reset shared mock store state
  mockCallStore.isInCall = false;
  mockCallStore.hasLiveCall = false;
  mockCallStore.activeCall = null;
  mockCallStore.matrixCall = null;
  mockCallStore.videoMuted = false;
  authState.matrixReady = true;
  matrixState.client = makeMockClient();
  // Default: permissions resolve successfully. Individual tests override
  // with mockRejectedValueOnce(new MockPermissionDeniedError(...)).
  mockEnsureCallPermissions.mockResolvedValue(undefined);
  // Reset user-store stubs to the default cached-profile shape so
  // tests that don't care about the resolvePeerInfo path don't have
  // to re-stage the mocks. Tests that exercise cold cache override
  // these via mockReturnValueOnce within the test body.
  mockGetUser.mockReset();
  mockGetUser.mockReturnValue({ name: 'Peer' });
  mockLoadUsersBatch.mockReset();
  mockLoadUsersBatch.mockResolvedValue(undefined);
  // Clear finalize-call's per-callId idempotency map between tests —
  // many tests reuse the same callId ('test-call-id', 'incoming-call-id'),
  // and a leftover finalized entry would short-circuit the cleanup
  // chain on the next run.
  const { __resetFinalizeCallStateForTests } = await import('./finalize-call');
  __resetFinalizeCallStateForTests();
}
