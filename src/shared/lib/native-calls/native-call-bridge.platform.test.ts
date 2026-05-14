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

describe('cold-start accept replay (iOS)', () => {
  // The cold-start-from-push flow on iOS:
  //   1. PushKit wakes the app; IOSVoIPPushPlugin asks
  //      @capgo/capacitor-incoming-call-kit to ring.
  //   2. User taps Accept on the lock screen BEFORE the WKWebView
  //      bridge is alive. The plugin marks the call's state as
  //      'accepted' inside its native cache.
  //   3. App finishes booting → nativeCallBridge.wire() runs.
  //   4. wire() calls NativeCall.getPendingAnswer() (which on iOS is
  //      our adapter routing to getActiveCalls → first state==accepted).
  //   5. waitForMatrixCallAndAnswer polls callStore.matrixCall until
  //      the SDK delivers the m.call.invite, then calls answerCall().
  // This test verifies steps 4-5 wire up correctly through the iOS path.

  it('seeds pendingAnswer from getActiveCalls() (state=accepted) and triggers callService.answerCall once matrixCall arrives', async () => {
    vi.useFakeTimers();

    const showIncomingCallSpy: Mock = vi.fn().mockResolvedValue({ call: {} });
    const getActiveCallsForBridgeSpy: Mock = vi.fn().mockResolvedValue({
      calls: [
        {
          callId: 'cold-start-call-99',
          state: 'accepted',
          extra: { roomId: '!cold-start-room:matrix.org' },
        },
      ],
    });
    const ickAddListener: Mock = vi.fn().mockResolvedValue({ remove: vi.fn() });
    const answerSpy: Mock = vi.fn();

    const matrixCallRef: { current: { callId?: string; roomId?: string } | null } = {
      current: null,
    };

    vi.resetModules();
    vi.doMock('@capacitor/core', () => ({
      registerPlugin: (name: string) => {
        if (name === 'IncomingCallKit') {
          return {
            showIncomingCall: showIncomingCallSpy,
            endCall: vi.fn().mockResolvedValue({ calls: [] }),
            getActiveCalls: getActiveCallsForBridgeSpy,
            endAllCalls: vi.fn().mockResolvedValue({ calls: [] }),
            requestPermissions: vi.fn(),
            addListener: ickAddListener,
          };
        }
        if (name === 'IOSCallAudio') {
          return new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) });
        }
        if (name === 'NativeCall') {
          return {
            requestAudioPermission: vi.fn().mockResolvedValue({ granted: true }),
            addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
            getPendingAnswer: vi.fn(),
            getPendingReject: vi.fn(),
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
    // The recovery loop dynamically imports useCallStore — supply a
    // controllable matrixCall ref so we can release the poll.
    vi.doMock('@/entities/call', () => ({
      useCallStore: () => ({
        get matrixCall() {
          return matrixCallRef.current;
        },
      }),
    }));
    // SDK probe used by the recovery pass — return false so the bridge
    // stays in poll mode (we'll just satisfy the match on roomId path).
    vi.doMock('@/entities/matrix', () => ({
      getMatrixClientService: () => ({
        client: { callEventHandler: { calls: new Map() } },
      }),
    }));

    const { nativeCallBridge } = await import('./native-call-bridge');

    // Wire kicks off getPendingAnswer → adapter → getActiveCalls.
    // After the await chain settles, the bridge schedules its first
    // poll tick at +300ms. Until then, callService.answerCall is silent.
    await nativeCallBridge.wire({
      answerCall: answerSpy,
      rejectCall: vi.fn(),
      hangup: vi.fn(),
    });

    expect(getActiveCallsForBridgeSpy).toHaveBeenCalled();
    expect(answerSpy).not.toHaveBeenCalled();

    // Now make the SDK "deliver" the invite by populating the store.
    matrixCallRef.current = {
      callId: 'cold-start-call-99',
      roomId: '!cold-start-room:matrix.org',
    };

    // Advance through the first poll tick (300ms) plus the dynamic
    // import microtask queue. waitForMatrixCallAndAnswer matches by
    // callId and fires answerCall.
    await vi.advanceTimersByTimeAsync(350);
    // Flush import + then() chains.
    await Promise.resolve();
    await Promise.resolve();

    expect(answerSpy).toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe('getInviteThrottleSnapshot — Android-only telemetry', () => {
  // The throttle snapshot is FCM-data-message latency telemetry baked
  // into FortaFirebaseMessagingService on Android. iOS uses PushKit,
  // which is real-time and not subject to FCM throttling, so the metric
  // does not apply. Short-circuiting before the native round-trip avoids
  // logging "method not registered" on every bug-report submission and
  // saves a guaranteed-empty IPC hop.

  async function loadBridgeAndReadSnapshot(platform: PlatformFlags): Promise<{
    snapshot: { records: unknown[] };
    nativeSpy: Mock;
  }> {
    const inviteSpy: Mock = vi.fn().mockResolvedValue({
      records: [
        {
          receivedAtMs: 1,
          sentAtMs: 0,
          deliveryLatencyMs: 1,
          expired: false,
          callId: 'native-result',
        },
      ],
    });
    vi.resetModules();
    vi.doMock('@capacitor/core', () => ({
      registerPlugin: (name: string) => {
        if (name === 'IncomingCallKit') {
          return {
            showIncomingCall: vi.fn(),
            endCall: vi.fn().mockResolvedValue({ calls: [] }),
            getActiveCalls: vi.fn().mockResolvedValue({ calls: [] }),
            endAllCalls: vi.fn().mockResolvedValue({ calls: [] }),
            requestPermissions: vi.fn(),
            addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
          };
        }
        if (name === 'IOSCallAudio') {
          return new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) });
        }
        if (name === 'NativeCall') {
          return {
            reportIncomingCall: vi.fn(),
            requestAudioPermission: vi.fn().mockResolvedValue({ granted: true }),
            addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
            getPendingAnswer: vi.fn().mockResolvedValue({ callId: null, roomId: null }),
            getPendingReject: vi.fn().mockResolvedValue({ callId: null, roomId: null }),
            getInviteThrottleSnapshot: inviteSpy,
            getAudioStatus: vi
              .fn()
              .mockResolvedValue({ mode: 'MODE_NORMAL', isSpeakerOn: false, isBtScoOn: false }),
          };
        }
        return new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) });
      },
    }));
    vi.doMock('@/shared/lib/platform', () => platform);
    vi.doMock('@/shared/lib/native-webrtc/native-webrtc-bridge', () => ({
      NativeWebRTC: { addListener: vi.fn() },
    }));
    vi.doMock('@capacitor/camera', () => ({
      Camera: { requestPermissions: vi.fn() },
    }));

    const { nativeCallBridge } = await import('./native-call-bridge');
    const snapshot = await nativeCallBridge.getInviteThrottleSnapshot();
    return { snapshot, nativeSpy: inviteSpy };
  }

  it('on Android: forwards through the native plugin and returns its records', async () => {
    const { snapshot, nativeSpy } = await loadBridgeAndReadSnapshot({
      isNative: true,
      isAndroid: true,
      isIOS: false,
      isElectron: false,
      isWeb: false,
      currentPlatform: 'android',
    });
    expect(nativeSpy).toHaveBeenCalledOnce();
    expect(snapshot.records).toHaveLength(1);
  });

  it('on iOS: short-circuits to empty records WITHOUT touching the native plugin', async () => {
    const { snapshot, nativeSpy } = await loadBridgeAndReadSnapshot({
      isNative: true,
      isAndroid: false,
      isIOS: true,
      isElectron: false,
      isWeb: false,
      currentPlatform: 'ios',
    });
    expect(snapshot).toEqual({ records: [] });
    expect(nativeSpy).not.toHaveBeenCalled();
  });

  it('on web: short-circuits to empty records WITHOUT touching the native plugin', async () => {
    const { snapshot, nativeSpy } = await loadBridgeAndReadSnapshot({
      isNative: false,
      isAndroid: false,
      isIOS: false,
      isElectron: false,
      isWeb: true,
      currentPlatform: 'web',
    });
    expect(snapshot).toEqual({ records: [] });
    expect(nativeSpy).not.toHaveBeenCalled();
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
