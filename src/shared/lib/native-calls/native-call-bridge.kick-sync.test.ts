import { describe, it, expect, vi, type Mock } from 'vitest';

/**
 * iPhone XR 2026-10-14: Forta in the background, a VoIP push rang CallKit, the
 * user tapped Accept, and the call never connected. Backgrounding had killed
 * the /sync long-poll and left the SDK in backoff, so the invite arrived only
 * once the user opened the app. The accept now wakes the sync when JS holds no
 * call yet (a push-launched cold start already worked: its sync starts fresh).
 */

const ROOM = '!XfcsFwyJkEXLRTnPzc:matrix.pocketnet.app';
const CALL_ID = '1791980834987Ga1rYqu0DZ9l5xv3';

type Listeners = Record<string, (payload: { callId: string; roomId?: string }) => void>;

async function loadBridge(listeners: Listeners, matrixCall: () => { callId?: string; roomId?: string } | null) {
  vi.resetModules();
  vi.doMock('@capacitor/core', () => ({
    registerPlugin: (name: string) => {
      if (name === 'NativeCall') {
        return {
          getPendingAnswer: vi.fn().mockResolvedValue({ callId: null, roomId: null, atMs: 0 }),
          getPendingReject: vi.fn().mockResolvedValue({ callId: null, roomId: null, atMs: 0 }),
          retirePendingMarkers: vi.fn().mockResolvedValue(undefined),
          addListener: vi.fn((event: string, handler: (p: { callId: string }) => void) => {
            listeners[event] = handler;
            return Promise.resolve({ remove: vi.fn() });
          }),
          requestAudioPermission: vi.fn().mockResolvedValue({ granted: true }),
          ensureIncomingCallVisible: vi.fn().mockResolvedValue(undefined),
          reportIncomingCall: vi.fn().mockResolvedValue(undefined),
        };
      }
      return new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) });
    },
  }));
  // The recovery pass after the grace window looks the call up in the SDK.
  vi.doMock('@/entities/matrix', () => ({ getMatrixClientService: () => ({ client: null }) }));
  vi.doMock('@/entities/call', () => ({
    useCallStore: () => ({ get matrixCall() { return matrixCall(); } }),
  }));
  vi.doMock('@/shared/lib/platform', () => ({
    isNative: true, isAndroid: true, isIOS: false, isElectron: false, isWeb: false, currentPlatform: 'android',
  }));
  vi.doMock('@/shared/lib/native-webrtc/native-webrtc-bridge', () => ({ NativeWebRTC: { addListener: vi.fn() } }));
  vi.doMock('@capacitor/camera', () => ({ Camera: { requestPermissions: vi.fn() } }));
  return await import('./native-call-bridge');
}

function makeService(kickSync: Mock) {
  return {
    answerCall: vi.fn(),
    rejectCall: vi.fn(),
    hangup: vi.fn(),
    currentCall: () => ({ callId: undefined }),
    kickSync,
  };
}

describe('NativeCallBridge — an accept before the invite wakes the sync', () => {
  it('kicks the Matrix sync at once and again every few seconds while JS holds no call', async () => {
    vi.useFakeTimers();
    try {
      const listeners: Listeners = {};
      const kickSync = vi.fn();
      const { nativeCallBridge } = await loadBridge(listeners, () => null);
      await nativeCallBridge.wire(makeService(kickSync));
      listeners.callAnswered({ callId: CALL_ID, roomId: ROOM });
      await vi.advanceTimersByTimeAsync(1500);
      expect(kickSync).toHaveBeenCalledTimes(1);
      // A kick lands only while the SDK waits to retry; the dead long-poll may
      // not have failed yet at the first one (review 2026-10-14).
      await vi.advanceTimersByTimeAsync(3000);
      expect(kickSync).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not kick it when the call is already there', async () => {
    vi.useFakeTimers();
    try {
      const listeners: Listeners = {};
      const kickSync = vi.fn();
      const { nativeCallBridge } = await loadBridge(listeners, () => ({ callId: CALL_ID, roomId: ROOM }));
      await nativeCallBridge.wire(makeService(kickSync));
      listeners.callAnswered({ callId: CALL_ID, roomId: ROOM });
      await vi.advanceTimersByTimeAsync(1500);
      expect(kickSync).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
