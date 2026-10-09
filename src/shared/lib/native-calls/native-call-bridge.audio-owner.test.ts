import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * C02 (calls review 2026-10-04): call A's stop runs from a queue after call B
 * has started routing. The bridge must not cancel B's start retry for it and
 * must hand A's id to the native side, which drops a stop for another owner.
 */
const startSpy = vi.fn();
const stopSpy = vi.fn().mockResolvedValue(undefined);

vi.mock('@capacitor/core', () => ({
  registerPlugin: (name: string) => {
    if (name === 'NativeCall') {
      return new Proxy(
        { startAudioRouting: startSpy, stopAudioRouting: stopSpy },
        { get: (t: Record<string, unknown>, k: string) => t[k] ?? vi.fn().mockResolvedValue({}) },
      );
    }
    return new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) });
  },
}));
vi.mock('@capacitor/camera', () => ({ Camera: { requestPermissions: vi.fn() } }));
vi.mock('@/shared/lib/native-webrtc/native-webrtc-bridge', () => ({ NativeWebRTC: { addListener: vi.fn() } }));
vi.mock('@/shared/lib/platform', () => ({
  isNative: true, isAndroid: true, isIOS: false, isElectron: false, isWeb: false, currentPlatform: 'android',
}));

async function bridge() {
  return (await import('./native-call-bridge')).nativeCallBridge;
}

describe('audio routing ownership in the bridge (C02)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    startSpy.mockReset();
    stopSpy.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("does not cancel the new call's start retry for an earlier call's stop", async () => {
    startSpy.mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined);
    const b = await bridge();
    const started = b.startAudioRouting({ callType: 'voice', callId: 'B' });
    await vi.advanceTimersByTimeAsync(0);
    await b.stopAudioRouting({ callId: 'A' });
    await vi.advanceTimersByTimeAsync(1000);
    await started;
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(stopSpy).toHaveBeenCalledWith({ callId: 'A' });
  });

  it('cancels the start retry when the same call stops', async () => {
    startSpy.mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined);
    const b = await bridge();
    const started = b.startAudioRouting({ callType: 'voice', callId: 'B' });
    await vi.advanceTimersByTimeAsync(0);
    await b.stopAudioRouting({ callId: 'B' });
    await vi.advanceTimersByTimeAsync(1000);
    await started;
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('a stop without a call id still cancels the pending start', async () => {
    startSpy.mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined);
    const b = await bridge();
    const started = b.startAudioRouting({ callType: 'voice', callId: 'B' });
    await vi.advanceTimersByTimeAsync(0);
    await b.stopAudioRouting();
    await vi.advanceTimersByTimeAsync(1000);
    await started;
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledWith({});
  });
});
