import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

/**
 * Platform-gate guards on `nativeCallBridge.wire()`. The two NativeWebRTC
 * listeners (`onNativeHangup`, `onNativeVideoToggle`) are fed by Android's
 * full-screen CallActivity, which iOS does not have (CallKit owns the
 * lock-screen ringer; the in-call UI runs in WKWebView). The native
 * WebRTC proxy is also gated to Android in `call-service.ts` — see
 * `call-service-platform-gate.test.ts`.
 *
 * Without the `if (isAndroid)` guard inside `wire()`, iOS would attach
 * listeners to a Capacitor plugin handle that has no Swift backing, which
 * surfaces as `UNIMPLEMENTED` warnings on every login and leaks the
 * remove handle in Capacitor's plugin registry across hot reloads. This
 * file pins the gate so a future refactor that widens it back to
 * `isNative` fails CI.
 */

const ickAddListenerSpy: Mock = vi.fn().mockResolvedValue({ remove: vi.fn() });
const nativeCallAddListenerSpy: Mock = vi.fn().mockResolvedValue({ remove: vi.fn() });
const getPendingAnswerSpy: Mock = vi.fn().mockResolvedValue({ callId: null, roomId: null });
const getPendingRejectSpy: Mock = vi.fn().mockResolvedValue({ callId: null, roomId: null });
const requestAudioSpy: Mock = vi.fn().mockResolvedValue({ granted: true });

const nativeWebRTCAddListenerSpy: Mock = vi
  .fn()
  .mockResolvedValue({ remove: vi.fn() });

vi.mock('@capacitor/core', () => ({
  registerPlugin: (name: string) => {
    if (name === 'IncomingCallKit') {
      return {
        showIncomingCall: vi.fn(),
        endCall: vi.fn().mockResolvedValue({ calls: [] }),
        getActiveCalls: vi.fn().mockResolvedValue({ calls: [] }),
        endAllCalls: vi.fn().mockResolvedValue({ calls: [] }),
        requestPermissions: vi.fn(),
        addListener: ickAddListenerSpy,
      };
    }
    if (name === 'IOSCallAudio') {
      return new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) });
    }
    if (name === 'NativeCall') {
      return {
        reportIncomingCall: vi.fn(),
        getPendingAnswer: getPendingAnswerSpy,
        getPendingReject: getPendingRejectSpy,
        reportOutgoingCall: vi.fn(),
        reportCallConnected: vi.fn(),
        reportCallEnded: vi.fn(),
        requestAudioPermission: requestAudioSpy,
        requestCameraPermission: vi.fn(),
        probeAudioAvailability: vi.fn(),
        getAudioDevices: vi.fn(),
        setAudioDevice: vi.fn(),
        startAudioRouting: vi.fn(),
        stopAudioRouting: vi.fn(),
        forceStopAudio: vi.fn(),
        getAudioStatus: vi.fn(),
        getInviteThrottleSnapshot: vi.fn(),
        addListener: nativeCallAddListenerSpy,
      };
    }
    return new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) });
  },
}));

vi.mock('@capacitor/camera', () => ({
  Camera: { requestPermissions: vi.fn().mockResolvedValue({ camera: 'granted' }) },
}));

vi.mock('@/shared/lib/native-webrtc/native-webrtc-bridge', () => ({
  NativeWebRTC: {
    addListener: nativeWebRTCAddListenerSpy,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  ickAddListenerSpy.mockResolvedValue({ remove: vi.fn() });
  nativeCallAddListenerSpy.mockResolvedValue({ remove: vi.fn() });
  getPendingAnswerSpy.mockResolvedValue({ callId: null, roomId: null });
  getPendingRejectSpy.mockResolvedValue({ callId: null, roomId: null });
  requestAudioSpy.mockResolvedValue({ granted: true });
  nativeWebRTCAddListenerSpy.mockResolvedValue({ remove: vi.fn() });
});

interface PlatformFlags {
  isNative: boolean;
  isAndroid: boolean;
  isIOS: boolean;
  isElectron: boolean;
  isWeb: boolean;
  currentPlatform: 'android' | 'ios' | 'electron' | 'web';
}

async function loadBridgeUnder(platform: PlatformFlags): Promise<typeof import('./native-call-bridge')> {
  vi.resetModules();
  vi.doMock('@/shared/lib/platform', () => platform);
  return import('./native-call-bridge');
}

describe('nativeCallBridge.wire() — platform gate', () => {
  it('on iOS: does NOT attach NativeWebRTC listeners (no full-screen CallActivity exists on iOS)', async () => {
    const mod = await loadBridgeUnder({
      isNative: true,
      isAndroid: false,
      isIOS: true,
      isElectron: false,
      isWeb: false,
      currentPlatform: 'ios',
    });
    await mod.nativeCallBridge.wire({
      answerCall: vi.fn(),
      rejectCall: vi.fn(),
      hangup: vi.fn(),
    });
    expect(nativeWebRTCAddListenerSpy).not.toHaveBeenCalled();
  });

  it('on iOS: attaches IncomingCallKit listeners (Android event names mapped to iOS plugin events)', async () => {
    const mod = await loadBridgeUnder({
      isNative: true,
      isAndroid: false,
      isIOS: true,
      isElectron: false,
      isWeb: false,
      currentPlatform: 'ios',
    });
    await mod.nativeCallBridge.wire({
      answerCall: vi.fn(),
      rejectCall: vi.fn(),
      hangup: vi.fn(),
    });
    // Should subscribe to all three CallKit events (mapped from
    // Android's callAnswered/callDeclined/callEnded).
    const events = ickAddListenerSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(events).toEqual(
      expect.arrayContaining(['callAccepted', 'callDeclined', 'callEnded']),
    );
    // Should NOT touch the Android NativeCall plugin at all.
    expect(nativeCallAddListenerSpy).not.toHaveBeenCalled();
  });

  it('on Android: DOES attach NativeWebRTC listeners (regression guard for the gate)', async () => {
    const mod = await loadBridgeUnder({
      isNative: true,
      isAndroid: true,
      isIOS: false,
      isElectron: false,
      isWeb: false,
      currentPlatform: 'android',
    });
    await mod.nativeCallBridge.wire({
      answerCall: vi.fn(),
      rejectCall: vi.fn(),
      hangup: vi.fn(),
    });
    const events = nativeWebRTCAddListenerSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(events).toEqual(
      expect.arrayContaining(['onNativeHangup', 'onNativeVideoToggle']),
    );
  });

  it('on web: wire() short-circuits before touching any plugin', async () => {
    const mod = await loadBridgeUnder({
      isNative: false,
      isAndroid: false,
      isIOS: false,
      isElectron: false,
      isWeb: true,
      currentPlatform: 'web',
    });
    await mod.nativeCallBridge.wire({
      answerCall: vi.fn(),
      rejectCall: vi.fn(),
      hangup: vi.fn(),
    });
    expect(ickAddListenerSpy).not.toHaveBeenCalled();
    expect(nativeCallAddListenerSpy).not.toHaveBeenCalled();
    expect(nativeWebRTCAddListenerSpy).not.toHaveBeenCalled();
  });
});

describe('reportIncomingCall and friends pass through the per-platform NativeCall handle', () => {
  it('on iOS: reportIncomingCall fires through IncomingCallKit, NOT NativeCall', async () => {
    const showIncomingCallSpy: Mock = vi.fn().mockResolvedValue({ call: {} });
    vi.resetModules();
    vi.doMock('@capacitor/core', () => ({
      registerPlugin: (name: string) => {
        if (name === 'IncomingCallKit') {
          return {
            showIncomingCall: showIncomingCallSpy,
            endCall: vi.fn().mockResolvedValue({ calls: [] }),
            getActiveCalls: vi.fn().mockResolvedValue({ calls: [] }),
            endAllCalls: vi.fn().mockResolvedValue({ calls: [] }),
            requestPermissions: vi.fn(),
            addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
          };
        }
        if (name === 'NativeCall') {
          return {
            reportIncomingCall: vi.fn(),
            requestAudioPermission: vi.fn().mockResolvedValue({ granted: true }),
            addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
            getPendingAnswer: vi.fn().mockResolvedValue({ callId: null, roomId: null }),
            getPendingReject: vi.fn().mockResolvedValue({ callId: null, roomId: null }),
          };
        }
        return new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) });
      },
    }));
    vi.doMock('@/shared/lib/platform', () => ({
      isNative: true,
      isAndroid: false,
      isIOS: true,
      isElectron: false,
      isWeb: false,
      currentPlatform: 'ios',
    }));
    vi.doMock('@/shared/lib/native-webrtc/native-webrtc-bridge', () => ({
      NativeWebRTC: { addListener: vi.fn() },
    }));
    vi.doMock('@capacitor/camera', () => ({
      Camera: { requestPermissions: vi.fn() },
    }));

    const { nativeCallBridge } = await import('./native-call-bridge');
    await nativeCallBridge.reportIncomingCall({
      callId: 'cx',
      callerName: 'Ada',
      roomId: '!r:m',
      hasVideo: false,
    });
    expect(showIncomingCallSpy).toHaveBeenCalledOnce();
    const arg = showIncomingCallSpy.mock.calls[0][0];
    expect(arg.callId).toBe('cx');
    expect(arg.extra.roomId).toBe('!r:m');
  });
});
