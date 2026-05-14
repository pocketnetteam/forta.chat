import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// WebRTC engine selection per platform — see
// docs/plans/ios/2026-05-12-ios-webrtc-decision.md (Plan A).
//
// The native WebRTC proxy + NativeWebRTCManager only exist to work around
// Android-specific issues (OEM HW AEC deadlocks on Xiaomi/Realme/Oppo/etc.,
// Chromium fragmentation in Android WebView, restartIce flakiness on old
// Android Chrome builds, MIUI privacy shield silently rejecting AudioRecord).
// iOS WKWebView ships a single vendor-controlled WebRTC stack that follows
// Safari's implementation — none of those Android workarounds apply.
//
// Installing the JS proxy on iOS would (a) hand the Matrix SDK a no-op
// `NativeWebRTC` Capacitor plugin (no Swift counterpart exists for Plan A)
// and (b) replace `window.RTCPeerConnection` with a stub that the SDK then
// tries to drive, silently breaking call setup. This test file guards the
// `if (isAndroid)` gate so a future refactor that widens it back to
// `isNative` fails CI instead of regressing iOS calls in production.
//
// This file is intentionally a SIBLING of `call-service.test.ts` rather
// than a `describe` block inside it. The call-service tests pin
// `isAndroid: true` via `vi.mock` at the top of the file; switching that
// pin mid-file with `vi.doMock` / `vi.doUnmock` was leaking platform mocks
// across tests. Vitest runs each test file in an isolated module graph,
// so per-platform gate assertions belong in their own file.
// ---------------------------------------------------------------------------

// Shared Capacitor stub so module-graph-level dependencies (deep imports
// inside `@capacitor/*` plugins reachable from call-service) don't blow up
// before we reach the gate. Each test mocks @/shared/lib/platform itself,
// which is what call-service.ts actually reads.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
  },
  registerPlugin: () => new Proxy({}, {
    get: () => vi.fn().mockResolvedValue({}),
  }),
}));

// Below mocks shadow the heavy collaborators that call-service eagerly
// imports at module load. We only care about the install gate firing or
// not, so every collaborator returns a tolerant no-op.
vi.mock('@/entities/matrix', () => ({
  getMatrixClientService: vi.fn(() => ({
    client: null,
    getUserId: vi.fn(() => '@me:matrix.org'),
  })),
}));

vi.mock('@/entities/call', () => ({
  useCallStore: () => ({
    isInCall: false,
    activeCall: null,
    matrixCall: null,
    updateStatus: vi.fn(),
    scheduleClearCall: vi.fn(),
    cancelScheduledClear: vi.fn(),
    setActiveCall: vi.fn(),
    setMatrixCall: vi.fn(),
    addHistoryEntry: vi.fn(),
    setLocalStream: vi.fn(),
    setLocalScreenStream: vi.fn(),
    setRemoteStream: vi.fn(),
    setRemoteScreenStream: vi.fn(),
    startTimer: vi.fn(),
    stopTimer: vi.fn(),
    clearCall: vi.fn(),
  }),
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

vi.mock('@/entities/user', () => ({
  useUserStore: () => ({
    loadUserIfMissing: vi.fn(),
    loadUsersBatch: vi.fn().mockResolvedValue(undefined),
    getUser: vi.fn(() => undefined),
  }),
}));

vi.mock('@/entities/chat/lib/chat-helpers', () => ({
  matrixIdToAddress: vi.fn((id: string) => id),
}));

vi.mock('matrix-js-sdk-bastyon/lib/webrtc/call', () => ({
  createNewMatrixCall: vi.fn(() => null),
  CallEvent: { State: 'State', FeedsChanged: 'FeedsChanged', Hangup: 'Hangup', Error: 'Error' },
  CallState: {
    Ringing: 'ringing', Connecting: 'connecting', Connected: 'connected', Ended: 'ended',
    CreateOffer: 'create_offer', CreateAnswer: 'create_answer',
    InviteSent: 'invite_sent', WaitLocalMedia: 'wait_local_media',
  },
  CallErrorCode: { UserHangup: 'user_hangup', IceFailed: 'ice_failed' },
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

vi.mock('./permissions', () => ({
  ensureCallPermissions: vi.fn().mockResolvedValue(undefined),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
  callPermissionError: { value: null },
  clearCallPermissionError: vi.fn(),
}));

vi.mock('@/shared/lib/native-calls', () => ({
  nativeCallBridge: new Proxy({}, {
    get: () => vi.fn().mockResolvedValue(undefined),
  }),
  consumePendingAnswerCallId: vi.fn().mockResolvedValue(false),
  consumePendingRejectCallId: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/features/bug-report', () => ({
  useBugReport: () => ({ open: vi.fn() }),
}));

vi.mock('@/shared/lib/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('@/shared/lib/i18n', () => ({
  tRaw: (key: string) => key,
}));

vi.mock('@/shared/lib/connectivity', () => ({
  onConnectivityChange: vi.fn(() => () => {}),
}));

vi.mock('./webrtc-diagnostics', () => ({
  webrtcDiagnostics: {
    attach: vi.fn(),
    detach: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
}));

vi.mock('./incoming-call-dedup', () => ({
  isIncomingCallSeen: vi.fn(() => false),
  markIncomingCallSeen: vi.fn(),
  clearIncomingCallSeen: vi.fn(),
}));

vi.mock('./finalize-call', () => ({
  finalizeCall: vi.fn().mockResolvedValue(undefined),
  __resetFinalizeCallStateForTests: vi.fn(),
}));

vi.mock('./webview-compatibility', () => ({
  isLegacyWebView: vi.fn(() => false),
  MIN_CHROMIUM_MAJOR_FOR_MODERN_WEBRTC: 100,
}));

// ---------------------------------------------------------------------------
// Helper — build the per-test mocks, swap them in, then re-import the module
// so the `if (isAndroid)` gate runs against the freshly-staged platform mock.
// ---------------------------------------------------------------------------

interface PlatformFlags {
  isNative: boolean;
  isAndroid: boolean;
  isIOS: boolean;
  isElectron: boolean;
  isWeb: boolean;
  currentPlatform: 'android' | 'ios' | 'electron' | 'web';
}

interface GateSpies {
  installSpy: Mock;
  addListenerSpy: Mock;
}

async function loadCallServiceUnderPlatform(platform: PlatformFlags): Promise<GateSpies> {
  vi.resetModules();

  const installSpy = vi.fn();
  const addListenerSpy = vi.fn().mockResolvedValue({ remove: vi.fn() });

  vi.doMock('@/shared/lib/platform', () => platform);
  vi.doMock('@/shared/lib/native-webrtc', () => ({
    installNativeWebRTCProxy: installSpy,
    NativeWebRTC: new Proxy({}, {
      get: (_target, prop) => {
        if (prop === 'addListener') return addListenerSpy;
        return vi.fn().mockResolvedValue({});
      },
    }),
  }));

  await import('./call-service');

  return { installSpy, addListenerSpy };
}

describe('call-service module-load WebRTC gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT install the native WebRTC proxy on iOS (Plan A: WKWebView built-in WebRTC)', async () => {
    // On iOS Plan A we rely on WKWebView's built-in RTCPeerConnection +
    // getUserMedia. The native proxy must stay dormant because (a) there
    // is no `IOSNativeWebRTC` Swift plugin shipped in Plan A — `pod
    // install` wouldn't register a handler, and Capacitor would surface
    // every proxy call as `UNIMPLEMENTED` — and (b) swapping
    // `window.RTCPeerConnection` for the proxy stub silently breaks
    // call setup for every outgoing and incoming call on the device.
    const { installSpy, addListenerSpy } = await loadCallServiceUnderPlatform({
      isNative: true,
      isAndroid: false,
      isIOS: true,
      isElectron: false,
      isWeb: false,
      currentPlatform: 'ios',
    });

    expect(installSpy).not.toHaveBeenCalled();
    // The whole `if (isAndroid)` block is skipped on iOS, so the
    // onAudioError listener must not be wired either — no Swift surface
    // would ever emit it, and registering a phantom listener leaks the
    // remove handle in Capacitor's plugin registry across hot reloads.
    const audioErrorRegistration = addListenerSpy.mock.calls.find(
      (call: unknown[]) => call[0] === 'onAudioError',
    );
    expect(audioErrorRegistration).toBeUndefined();
  });

  it('DOES install the native WebRTC proxy on Android (regression guard)', async () => {
    // Symmetric guard: if someone narrows the gate (e.g. accidentally
    // requires `isIOS` too) AND the iOS test above stays green, this
    // catches the resulting silent regression on Android — where the
    // proxy is the actual fix for OEM HW AEC deadlocks, MIUI privacy
    // shield, and the Chromium-version fragmentation that plagues
    // Android WebView. The onAudioError listener is part of that fix
    // because the native NativeWebRTCManager surfaces permission /
    // device errors through it; without the listener the call-service
    // can't drive the failed → scheduleClearCall path on Android.
    const { installSpy, addListenerSpy } = await loadCallServiceUnderPlatform({
      isNative: true,
      isAndroid: true,
      isIOS: false,
      isElectron: false,
      isWeb: false,
      currentPlatform: 'android',
    });

    expect(installSpy).toHaveBeenCalledOnce();
    const audioErrorRegistration = addListenerSpy.mock.calls.find(
      (call: unknown[]) => call[0] === 'onAudioError',
    );
    expect(audioErrorRegistration).toBeTruthy();
  });

  it('does NOT install the native WebRTC proxy on plain web (regression guard)', async () => {
    // Web has no Capacitor plugin host, so installing the proxy is
    // always wrong here — it would replace `window.RTCPeerConnection`
    // with a stub that routes to a non-existent Capacitor bridge.
    // Documented as part of the gate's contract so future contributors
    // who refactor platform.ts can see what behavior to preserve.
    const { installSpy } = await loadCallServiceUnderPlatform({
      isNative: false,
      isAndroid: false,
      isIOS: false,
      isElectron: false,
      isWeb: true,
      currentPlatform: 'web',
    });

    expect(installSpy).not.toHaveBeenCalled();
  });

  it('does NOT install the native WebRTC proxy in Electron (regression guard)', async () => {
    // Electron uses a bundled Chromium with the standard WebRTC stack;
    // there is no native bridge, so the proxy must not install. This
    // also covers the desktop call path that flows through the same
    // module-load code.
    const { installSpy } = await loadCallServiceUnderPlatform({
      isNative: false,
      isAndroid: false,
      isIOS: false,
      isElectron: true,
      isWeb: false,
      currentPlatform: 'electron',
    });

    expect(installSpy).not.toHaveBeenCalled();
  });
});
