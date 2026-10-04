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
  const { nativeCallBridge } = await import('./native-call-bridge');
  return { nativeCallBridge, added };
}

function service() {
  return {
    answerCall: vi.fn(),
    rejectCall: vi.fn(),
    hangup: vi.fn(),
    setLocalVideoMuted: vi.fn(),
    currentCall: () => null,
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
});
