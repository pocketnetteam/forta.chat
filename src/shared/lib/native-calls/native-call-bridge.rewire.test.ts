import { describe, it, expect, vi } from 'vitest';

/**
 * Regression: wire() runs on every Matrix init (re-login, account switch, no
 * page reload) and each run added another set of native listeners, so a
 * native hangup or video toggle reached call-service twice.
 */

type Handler = (payload: Record<string, unknown>) => void;

async function setup() {
  const added: Array<{ event: string; handler: Handler }> = [];
  const addListener = vi.fn((event: string, handler: Handler) => {
    added.push({ event, handler });
    return Promise.resolve({ remove: vi.fn() });
  });
  vi.resetModules();
  vi.doMock('@capacitor/core', () => ({
    registerPlugin: () =>
      new Proxy(
        {
          addListener,
          getPendingAnswer: vi.fn().mockResolvedValue({ callId: null, roomId: null, atMs: 0 }),
          getPendingReject: vi.fn().mockResolvedValue({ callId: null, roomId: null, atMs: 0 }),
        },
        { get: (t: Record<string, unknown>, p: string) => t[p] ?? vi.fn().mockResolvedValue({}) },
      ),
  }));
  vi.doMock('@/shared/lib/platform', () => ({
    isNative: true,
    isAndroid: true,
    isIOS: false,
    isElectron: false,
    isWeb: false,
    currentPlatform: 'android' as const,
  }));
  vi.doMock('@/shared/lib/native-webrtc/native-webrtc-bridge', () => ({
    NativeWebRTC: { addListener },
  }));
  vi.doMock('@/entities/call', () => ({
    useCallStore: () => ({ matrixCall: null }),
  }));
  vi.doMock('@/entities/matrix', () => ({
    getMatrixClientService: () => ({ client: { callEventHandler: { calls: new Map() }, getRooms: () => [] } }),
  }));
  const { nativeCallBridge } = await import('./native-call-bridge');
  return { nativeCallBridge, added };
}

function service() {
  return {
    answerCall: vi.fn(),
    rejectCall: vi.fn(),
    hangup: vi.fn(),
    setLocalVideoMuted: vi.fn(),
    currentCall: () => ({ callId: undefined }),
  };
}

describe('nativeCallBridge.wire() called again', () => {
  it('adds each native listener once', async () => {
    const { nativeCallBridge, added } = await setup();
    await nativeCallBridge.wire(service());
    const once = added.length;
    await nativeCallBridge.wire(service());
    expect(once).toBeGreaterThan(0);
    expect(added.length).toBe(once);
  });

  it('routes native events to the latest call service', async () => {
    const { nativeCallBridge, added } = await setup();
    const first = service();
    const second = service();
    await nativeCallBridge.wire(first);
    await nativeCallBridge.wire(second);
    added.filter((a) => a.event === 'onNativeHangup').forEach((a) => a.handler({}));
    added.filter((a) => a.event === 'onNativeVideoToggle').forEach((a) => a.handler({ enabled: true }));
    expect(second.hangup).toHaveBeenCalledTimes(1);
    expect(second.setLocalVideoMuted).toHaveBeenCalledTimes(1);
    expect(first.hangup).not.toHaveBeenCalled();
  });

  // Regression (Samsung 2026-10-05): Accept tapped just as the caller hung up
  // — the SDK never made a call, the wait timed out with a warning, and the
  // natively answered connection stayed ACTIVE, refusing later calls as busy.
  it('releases the native answer when no call arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const { nativeCallBridge, added } = await setup();
      const svc = { ...service(), releaseOrphanedNativeAnswer: vi.fn() };
      await nativeCallBridge.wire(svc);
      added.find((a) => a.event === 'callAnswered')!.handler({ callId: 'orphan-call', roomId: '!room:x' });
      // Step the 300 ms poll, letting each tick's dynamic imports settle.
      for (let i = 0; i < 110; i++) {
        await vi.advanceTimersByTimeAsync(300);
        await new Promise((r) => setImmediate(r));
      }
      expect(svc.releaseOrphanedNativeAnswer).toHaveBeenCalledWith('orphan-call', '!room:x');
      expect(svc.answerCall).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
