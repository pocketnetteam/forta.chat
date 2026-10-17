import { describe, it, expect, vi, type Mock } from 'vitest';

/**
 * Declines from the native ringer (calls review 2026-10-04, C07 and C08).
 *
 * C08: on iOS a decline on CallKit that comes before Matrix delivered the
 * invite found no call to reject, and nothing kept the decision, so the late
 * invite rang. C07: a repeated VoIP push after the answer showed a second
 * ringer for the live call, and declining it hung that call up.
 */

const ROOM = '!XfcsFwyJkEXLRTnPzc:matrix.pocketnet.app';
const PUSH_EVENT_ID = '$ZM8kQ5-push-event-id';
const MATRIX_CALL = '1789002456340bHi7Fz1DUPFPFOt4';

type IosEvent = { call: { callId: string; extra?: { roomId?: string } } };

async function wireIosBridge(held: { callId?: string; state?: string }) {
  const listeners: Record<string, (e: IosEvent) => void> = {};
  vi.resetModules();
  vi.doMock('@capacitor/core', () => ({
    registerPlugin: (name: string) => {
      if (name === 'IncomingCallKit') {
        return {
          addListener: vi.fn((event: string, handler: (e: IosEvent) => void) => {
            listeners[event] = handler;
            return Promise.resolve({ remove: vi.fn() });
          }),
          getActiveCalls: vi.fn().mockResolvedValue({ calls: [] }),
          endCall: vi.fn().mockResolvedValue({ calls: [] }),
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
    currentPlatform: 'ios' as const,
  }));
  vi.doMock('@/shared/lib/native-webrtc/native-webrtc-bridge', () => ({
    NativeWebRTC: { addListener: vi.fn() },
  }));
  vi.doMock('@/entities/call', () => ({
    useCallStore: () => ({ matrixCall: held.callId ? { callId: held.callId, roomId: ROOM } : null }),
  }));
  const callService = {
    answerCall: vi.fn(),
    rejectCall: vi.fn() as Mock,
    hangup: vi.fn() as Mock,
    currentCall: () => ({ callId: held.callId, roomId: ROOM, state: held.state }),
  };
  const bridgeModule = await import('./native-call-bridge');
  await bridgeModule.nativeCallBridge.wire(callService);
  return { listeners, callService, bridgeModule };
}

describe('declines from the native ringer', () => {
  it('C08: keeps a decline that came before the invite, for that invite', async () => {
    const { listeners, callService, bridgeModule } = await wireIosBridge({});

    listeners.callDeclined({ call: { callId: PUSH_EVENT_ID, extra: { roomId: ROOM } } });

    expect(callService.rejectCall).not.toHaveBeenCalled();
    await expect(bridgeModule.consumePendingRejectCallId(MATRIX_CALL, ROOM)).resolves.toBe(true);
  });

  it('C08: a decline while a call is held still rejects that call and keeps nothing', async () => {
    const { listeners, callService, bridgeModule } = await wireIosBridge({ callId: MATRIX_CALL, state: 'ringing' });

    listeners.callDeclined({ call: { callId: MATRIX_CALL, extra: { roomId: ROOM } } });

    expect(callService.rejectCall).toHaveBeenCalledTimes(1);
    await expect(bridgeModule.consumePendingRejectCallId('a-later-call', ROOM)).resolves.toBe(false);
  });

  it('C07: a decline for a call already answered does not hang it up', async () => {
    const { listeners, callService } = await wireIosBridge({ callId: MATRIX_CALL, state: 'connected' });

    listeners.callDeclined({ call: { callId: MATRIX_CALL, extra: { roomId: ROOM } } });

    expect(callService.rejectCall).not.toHaveBeenCalled();
  });
});
