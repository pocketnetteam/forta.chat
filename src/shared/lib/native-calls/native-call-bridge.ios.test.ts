import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

/**
 * Tests for the iOS adapter that routes the Android-shaped
 * `NativeCallNativePlugin` contract to `@capgo/capacitor-incoming-call-kit`
 * + the (Step 6 Task 4) `IOSCallAudio` plugin.
 *
 * The bridge wrapper (`native-call-bridge.ts`) is platform-agnostic; the
 * adapter is the place where iOS-specific event/payload translations live.
 * This file pins those translations with regression tests so a future
 * refactor that, say, swaps `extra.roomId` for `extra.room` or stops
 * unwrapping the `event.call` envelope fails CI instead of breaking iOS
 * call setup silently.
 */

const showIncomingCallSpy: Mock = vi.fn().mockResolvedValue({ call: {} });
const endCallSpy: Mock = vi.fn().mockResolvedValue({ calls: [] });
const getActiveCallsSpy: Mock = vi.fn().mockResolvedValue({ calls: [] });
const ickAddListenerSpy: Mock = vi.fn().mockResolvedValue({ remove: vi.fn() });

const audioRequestRecordSpy: Mock = vi.fn().mockResolvedValue({ granted: true });
const audioStartSpy: Mock = vi.fn().mockResolvedValue(undefined);
const audioStopSpy: Mock = vi.fn().mockResolvedValue(undefined);
const audioForceStopSpy: Mock = vi.fn().mockResolvedValue(undefined);
const audioGetStatusSpy: Mock = vi.fn().mockResolvedValue({
  mode: 'MODE_IN_COMMUNICATION',
  isSpeakerOn: false,
  isBtScoOn: false,
});
const audioProbeSpy: Mock = vi.fn().mockResolvedValue({
  available: true,
  hasInput: true,
  canInit: true,
  conflicting: [],
});

const cameraRequestPermissionsSpy: Mock = vi.fn().mockResolvedValue({ camera: 'granted' });

vi.mock('@capacitor/core', () => ({
  registerPlugin: (name: string) => {
    if (name === 'IncomingCallKit') {
      return {
        showIncomingCall: showIncomingCallSpy,
        endCall: endCallSpy,
        endAllCalls: vi.fn().mockResolvedValue({ calls: [] }),
        getActiveCalls: getActiveCallsSpy,
        requestPermissions: vi.fn().mockResolvedValue({
          notifications: 'notApplicable',
          fullScreenIntent: 'notApplicable',
        }),
        addListener: ickAddListenerSpy,
      };
    }
    if (name === 'IOSCallAudio') {
      return {
        requestRecordPermission: audioRequestRecordSpy,
        probeAvailability: audioProbeSpy,
        start: audioStartSpy,
        stop: audioStopSpy,
        forceStop: audioForceStopSpy,
        getStatus: audioGetStatusSpy,
        setOutput: vi.fn().mockResolvedValue(undefined),
      };
    }
    return new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) });
  },
}));

vi.mock('@capacitor/camera', () => ({
  Camera: {
    requestPermissions: cameraRequestPermissionsSpy,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  showIncomingCallSpy.mockResolvedValue({ call: {} });
  endCallSpy.mockResolvedValue({ calls: [] });
  getActiveCallsSpy.mockResolvedValue({ calls: [] });
  ickAddListenerSpy.mockResolvedValue({ remove: vi.fn() });
  audioRequestRecordSpy.mockResolvedValue({ granted: true });
  audioStartSpy.mockResolvedValue(undefined);
  audioStopSpy.mockResolvedValue(undefined);
  audioForceStopSpy.mockResolvedValue(undefined);
  audioGetStatusSpy.mockResolvedValue({
    mode: 'MODE_IN_COMMUNICATION',
    isSpeakerOn: false,
    isBtScoOn: false,
  });
  audioProbeSpy.mockResolvedValue({
    available: true,
    hasInput: true,
    canInit: true,
    conflicting: [],
  });
  cameraRequestPermissionsSpy.mockResolvedValue({ camera: 'granted' });
});

afterEach(() => {
  vi.resetModules();
});

async function loadAdapter() {
  const mod = await import('./native-call-bridge.ios');
  return mod.createIOSNativeCallAdapter();
}

describe('createIOSNativeCallAdapter — reportIncomingCall', () => {
  it('forwards to IncomingCallKit.showIncomingCall with roomId in extra and ios.handleType=generic', async () => {
    const adapter = await loadAdapter();
    await adapter.reportIncomingCall({
      callId: 'call-123',
      callerName: 'Ada',
      roomId: '!room:matrix.org',
      hasVideo: true,
    });
    expect(showIncomingCallSpy).toHaveBeenCalledOnce();
    const arg = showIncomingCallSpy.mock.calls[0][0];
    expect(arg.callId).toBe('call-123');
    expect(arg.callerName).toBe('Ada');
    // Matrix room id surfaces both as the secondary CallKit handle AND
    // as `extra.roomId` so callAccepted/Declined events can correlate
    // back to the room without a parallel JS-side cache.
    expect(arg.handle).toBe('!room:matrix.org');
    expect(arg.extra.roomId).toBe('!room:matrix.org');
    expect(arg.hasVideo).toBe(true);
    // CallKit handleType: 'generic' — the room id is not a phone number
    // or email, so 'phoneNumber' would format as a tel: link in the
    // Recents UI, which is wrong.
    expect(arg.ios.handleType).toBe('generic');
  });

  it('rethrows the underlying showIncomingCall failure (so the bridge can fall back to in-app ringer)', async () => {
    showIncomingCallSpy.mockRejectedValueOnce(new Error('CallKit busy'));
    const adapter = await loadAdapter();
    await expect(
      adapter.reportIncomingCall({
        callId: 'c1',
        callerName: 'X',
        roomId: '!r:m',
        hasVideo: false,
      }),
    ).rejects.toThrow('CallKit busy');
  });
});

describe('createIOSNativeCallAdapter — getPendingAnswer / getPendingReject', () => {
  it('returns the first call with state === "accepted" from getActiveCalls', async () => {
    getActiveCallsSpy.mockResolvedValueOnce({
      calls: [
        { callId: 'old-1', state: 'ringing', extra: { roomId: '!a:m' } },
        { callId: 'cold-2', state: 'accepted', extra: { roomId: '!b:m' } },
        { callId: 'old-3', state: 'accepted', extra: { roomId: '!c:m' } },
      ],
    });
    const adapter = await loadAdapter();
    const pending = await adapter.getPendingAnswer();
    expect(pending.callId).toBe('cold-2');
    expect(pending.roomId).toBe('!b:m');
  });

  it('returns nulls when no accepted call is queued', async () => {
    getActiveCallsSpy.mockResolvedValueOnce({
      calls: [{ callId: 'still-ringing', state: 'ringing', extra: { roomId: '!a:m' } }],
    });
    const adapter = await loadAdapter();
    const pending = await adapter.getPendingAnswer();
    expect(pending).toEqual({ callId: null, roomId: null });
  });

  it('swallows getActiveCalls failures and returns nulls (must NOT throw — bridge consumes this on every wire())', async () => {
    getActiveCallsSpy.mockRejectedValueOnce(new Error('plugin gone'));
    const adapter = await loadAdapter();
    const pending = await adapter.getPendingAnswer();
    expect(pending).toEqual({ callId: null, roomId: null });
  });

  it('returns null roomId when extra.roomId is missing or non-string', async () => {
    getActiveCallsSpy.mockResolvedValueOnce({
      calls: [{ callId: 'no-room', state: 'accepted', extra: {} }],
    });
    const adapter = await loadAdapter();
    const pending = await adapter.getPendingAnswer();
    expect(pending.callId).toBe('no-room');
    expect(pending.roomId).toBeNull();
  });

  it('getPendingReject returns the first ended call (cold-start decline)', async () => {
    getActiveCallsSpy.mockResolvedValueOnce({
      calls: [
        { callId: 'r1', state: 'ringing', extra: { roomId: '!a:m' } },
        { callId: 'r2', state: 'ended', extra: { roomId: '!b:m' } },
      ],
    });
    const adapter = await loadAdapter();
    const rej = await adapter.getPendingReject();
    expect(rej).toEqual({ callId: 'r2', roomId: '!b:m' });
  });
});

describe('createIOSNativeCallAdapter — addListener event mapping', () => {
  it('maps Android "callAnswered" to IncomingCallKit "callAccepted" and unwraps event.call', async () => {
    const adapter = await loadAdapter();
    const cb = vi.fn();
    await adapter.addListener('callAnswered', cb);

    expect(ickAddListenerSpy).toHaveBeenCalledOnce();
    const [eventName, handler] = ickAddListenerSpy.mock.calls[0];
    expect(eventName).toBe('callAccepted');

    handler({
      call: { callId: 'cid', extra: { roomId: '!r:m' } },
      source: 'user',
    });
    expect(cb).toHaveBeenCalledWith({ callId: 'cid', roomId: '!r:m' });
  });

  it('maps "callDeclined" 1:1 (same name on both sides) but still unwraps event.call', async () => {
    const adapter = await loadAdapter();
    const cb = vi.fn();
    await adapter.addListener('callDeclined', cb);

    const [eventName, handler] = ickAddListenerSpy.mock.calls[0];
    expect(eventName).toBe('callDeclined');

    handler({ call: { callId: 'd1', extra: { roomId: '!d:m' } }, source: 'user' });
    expect(cb).toHaveBeenCalledWith({ callId: 'd1', roomId: '!d:m' });
  });

  it('maps "callEnded" 1:1 and tolerates missing extra.roomId', async () => {
    const adapter = await loadAdapter();
    const cb = vi.fn();
    await adapter.addListener('callEnded', cb);

    const [eventName, handler] = ickAddListenerSpy.mock.calls[0];
    expect(eventName).toBe('callEnded');

    handler({ call: { callId: 'e1', extra: {} }, source: 'system' });
    expect(cb).toHaveBeenCalledWith({ callId: 'e1', roomId: undefined });
  });

  it('returns a no-op listener handle for "audioDevicesChanged" (no iOS equivalent in v1)', async () => {
    const adapter = await loadAdapter();
    const handle = await adapter.addListener('audioDevicesChanged', vi.fn());
    expect(typeof handle.remove).toBe('function');
    // IncomingCallKit must NOT be subscribed for this synthetic event.
    expect(ickAddListenerSpy).not.toHaveBeenCalled();
  });
});

describe('createIOSNativeCallAdapter — outgoing-call no-ops', () => {
  it('reportOutgoingCall is a no-op (CallKit outgoing-call API not exposed by plugin)', async () => {
    const adapter = await loadAdapter();
    await expect(
      adapter.reportOutgoingCall({ callId: 'o1', callerName: 'X', hasVideo: false }),
    ).resolves.toBeUndefined();
    expect(showIncomingCallSpy).not.toHaveBeenCalled();
  });

  it('reportCallConnected is a no-op (CallKit auto-connects on Accept tap)', async () => {
    const adapter = await loadAdapter();
    await expect(
      adapter.reportCallConnected({ callId: 'c1' }),
    ).resolves.toBeUndefined();
    expect(showIncomingCallSpy).not.toHaveBeenCalled();
  });
});

describe('createIOSNativeCallAdapter — reportCallEnded', () => {
  it('forwards to IncomingCallKit.endCall', async () => {
    const adapter = await loadAdapter();
    await adapter.reportCallEnded({ callId: 'e1' });
    expect(endCallSpy).toHaveBeenCalledWith({ callId: 'e1' });
  });

  it('swallows endCall failures (the call may already be gone, e.g. CallKit timed it out)', async () => {
    endCallSpy.mockRejectedValueOnce(new Error('not tracked'));
    const adapter = await loadAdapter();
    await expect(adapter.reportCallEnded({ callId: 'e1' })).resolves.toBeUndefined();
  });
});

describe('createIOSNativeCallAdapter — audio routing', () => {
  it('startAudioRouting forwards callType to IOSCallAudio.start', async () => {
    const adapter = await loadAdapter();
    await adapter.startAudioRouting({ callType: 'video' });
    expect(audioStartSpy).toHaveBeenCalledWith({ callType: 'video' });
  });

  it('stopAudioRouting / forceStopAudio fan out to IOSCallAudio', async () => {
    const adapter = await loadAdapter();
    await adapter.stopAudioRouting();
    await adapter.forceStopAudio();
    expect(audioStopSpy).toHaveBeenCalledOnce();
    expect(audioForceStopSpy).toHaveBeenCalledOnce();
  });

  it('getAudioStatus passes through IOSCallAudio.getStatus', async () => {
    audioGetStatusSpy.mockResolvedValueOnce({
      mode: 'MODE_IN_COMMUNICATION',
      isSpeakerOn: true,
      isBtScoOn: false,
    });
    const adapter = await loadAdapter();
    const status = await adapter.getAudioStatus();
    expect(status.isSpeakerOn).toBe(true);
    expect(status.mode).toBe('MODE_IN_COMMUNICATION');
  });

  it('getAudioStatus falls back to MODE_NORMAL when the plugin throws (older builds)', async () => {
    audioGetStatusSpy.mockRejectedValueOnce(new Error('not registered'));
    const adapter = await loadAdapter();
    const status = await adapter.getAudioStatus();
    expect(status.mode).toBe('MODE_NORMAL');
  });

  it('startAudioRouting does NOT throw when IOSCallAudio.start fails (graceful degradation, parity with Android)', async () => {
    audioStartSpy.mockRejectedValueOnce(new Error('AVAudioSession busy'));
    const adapter = await loadAdapter();
    await expect(adapter.startAudioRouting({ callType: 'voice' })).resolves.toBeUndefined();
  });
});

describe('createIOSNativeCallAdapter — getAudioDevices / setAudioDevice', () => {
  it('returns a single synthetic "default" device (v1 — system Control Center route picker handles real routing)', async () => {
    const adapter = await loadAdapter();
    const result = await adapter.getAudioDevices();
    expect(result.active).toBe('default');
    expect(result.devices).toEqual([{ type: 'default', name: 'Default' }]);
  });

  it('setAudioDevice is a v1 no-op', async () => {
    const adapter = await loadAdapter();
    await expect(adapter.setAudioDevice({ type: 'speaker' })).resolves.toBeUndefined();
  });
});

describe('createIOSNativeCallAdapter — permissions', () => {
  it('requestAudioPermission delegates to IOSCallAudio.requestRecordPermission', async () => {
    audioRequestRecordSpy.mockResolvedValueOnce({ granted: true });
    const adapter = await loadAdapter();
    const r = await adapter.requestAudioPermission();
    expect(r).toEqual({ granted: true });
    expect(audioRequestRecordSpy).toHaveBeenCalledOnce();
  });

  it('requestAudioPermission returns granted=false on plugin error (so call setup fails fast instead of silently dropping audio)', async () => {
    audioRequestRecordSpy.mockRejectedValueOnce(new Error('plugin missing'));
    const adapter = await loadAdapter();
    const r = await adapter.requestAudioPermission();
    expect(r).toEqual({ granted: false });
  });

  it('requestCameraPermission routes through @capacitor/camera (NOT IncomingCallKit — CallKit is audio-only)', async () => {
    const adapter = await loadAdapter();
    const r = await adapter.requestCameraPermission();
    expect(r).toEqual({ granted: true });
    expect(cameraRequestPermissionsSpy).toHaveBeenCalledWith({ permissions: ['camera'] });
  });

  it('requestCameraPermission returns granted=false when camera permission is denied', async () => {
    cameraRequestPermissionsSpy.mockResolvedValueOnce({ camera: 'denied' });
    const adapter = await loadAdapter();
    const r = await adapter.requestCameraPermission();
    expect(r).toEqual({ granted: false });
  });
});

describe('createIOSNativeCallAdapter — getInviteThrottleSnapshot', () => {
  it('always returns an empty record list (PushKit is real-time, not subject to FCM throttling)', async () => {
    const adapter = await loadAdapter();
    const snap = await adapter.getInviteThrottleSnapshot();
    expect(snap.records).toEqual([]);
  });
});
