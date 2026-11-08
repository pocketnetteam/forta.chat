// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  mockRequestAudioPermission,
  mockStartAudioRouting,
  mockStopAudioRouting,
  mockUpdateStatus,
  mockCallStore,
  mockPlaceVoiceCall,
  mockPlaceVideoCall,
  mockAnswer,
  mockReject,
  mockHangup,
  mockOn,
  mockOff,
  resetCallServiceHarness,
} from './call-service.harness';

describe('call-service: native audio routing', () => {
  beforeEach(resetCallServiceHarness);

  describe('audio routing lifecycle (AudioRouter wiring)', () => {
    beforeEach(() => {
      mockStartAudioRouting.mockClear();
      mockStopAudioRouting.mockClear();
    });

    it('calls startAudioRouting after placeVoiceCall with callType=voice', async () => {
      mockRequestAudioPermission.mockResolvedValue({ granted: true });

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      expect(mockPlaceVoiceCall).toHaveBeenCalledOnce();
      expect(mockStartAudioRouting).toHaveBeenCalledWith({ callType: 'voice', callId: 'test-call-id' });
    });

    it('calls startAudioRouting after placeVideoCall with callType=video', async () => {
      mockRequestAudioPermission.mockResolvedValue({ granted: true });

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'video');

      expect(mockPlaceVideoCall).toHaveBeenCalledOnce();
      expect(mockStartAudioRouting).toHaveBeenCalledWith({ callType: 'video', callId: 'test-call-id' });
    });

    it('does NOT call startAudioRouting when placeCall throws', async () => {
      mockRequestAudioPermission.mockResolvedValue({ granted: true });
      mockPlaceVoiceCall.mockRejectedValueOnce(new Error('fail'));

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      expect(mockStartAudioRouting).not.toHaveBeenCalled();
    });

    it('does NOT reject the call if startAudioRouting fails (graceful degradation)', async () => {
      mockRequestAudioPermission.mockResolvedValue({ granted: true });
      mockStartAudioRouting.mockRejectedValueOnce(new Error('router failed'));

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      // Place call still succeeded, no failed status was set due to routing error
      expect(mockPlaceVoiceCall).toHaveBeenCalledOnce();
      // updateStatus should NOT have been called with 'failed' because of routing
      const failedCalls = mockUpdateStatus.mock.calls.filter(
        (args) => args[0] === 'failed'
      );
      expect(failedCalls).toHaveLength(0);
    });

    it('calls startAudioRouting after answering incoming call', async () => {
      mockRequestAudioPermission.mockResolvedValue({ granted: true });

      mockCallStore.matrixCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type: 'voice',
        on: mockOn,
        off: mockOff,
        answer: mockAnswer,
        localUsermediaStream: null,
        localScreensharingStream: null,
        remoteUsermediaStream: null,
        remoteScreensharingStream: null,
        remoteUsermediaFeed: null,
      };
      mockCallStore.activeCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type: 'voice',
        direction: 'incoming',
        peerName: 'Peer',
        status: 'incoming',
      };

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();

      expect(mockAnswer).toHaveBeenCalledOnce();
      expect(mockStartAudioRouting).toHaveBeenCalledWith({ callType: 'voice', callId: 'incoming-call-id' });
    });

    it('calls stopAudioRouting on hangup', async () => {
      mockCallStore.matrixCall = {
        callId: 'test-call-id',
        on: mockOn,
        off: mockOff,
        hangup: mockHangup,
      };

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      service.hangup();

      expect(mockHangup).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(mockStopAudioRouting).toHaveBeenCalledOnce());
    });

    it('calls stopAudioRouting on rejectCall', async () => {
      mockCallStore.matrixCall = {
        callId: 'test-call-id',
        on: mockOn,
        off: mockOff,
        reject: mockReject,
      };
      mockCallStore.activeCall = {
        callId: 'test-call-id',
        roomId: '!room:matrix.org',
        peerId: '@peer:matrix.org',
        peerName: 'Peer',
        type: 'voice',
        direction: 'incoming',
      };

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      service.rejectCall();

      expect(mockReject).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(mockStopAudioRouting).toHaveBeenCalledOnce());
    });

    it('does not throw when stopAudioRouting fails', async () => {
      mockStopAudioRouting.mockRejectedValueOnce(new Error('stop failed'));
      mockCallStore.matrixCall = {
        callId: 'test-call-id',
        on: mockOn,
        off: mockOff,
        hangup: mockHangup,
      };

      const { useCallService } = await import('./call-service');
      const service = useCallService();

      expect(() => service.hangup()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Session 01 / H1 + H7: audioRouter lifecycle must be idempotent on error.
  //
  // Before this fix, when `call.answer()` threw inside answerCall (OEM audio
  // deadlock, BT routing conflict with CallActivity's duplicate AudioRouter),
  // the catch block did NOT call stopAudioRouting. MODE_IN_COMMUNICATION would
  // stay set, BT SCO would remain held, and the device's earpiece could be
  // stuck in "phone call" state until reboot. Symmetric problem on startCall
  // when placeVoiceCall/placeVideoCall throws.
  //
  // The fix: catch block (or finally equivalent) always calls stopAudioRouting.
  // Native side is idempotent, so a no-op stop is safe even if start was never
  // reached. This closes the #442/#443/#408 class of bugs where the mic or
  // earpiece gets stuck between calls.
  // -------------------------------------------------------------------------
  describe('audioRouter lifecycle on error (H1/H7)', () => {
    beforeEach(() => {
      mockStartAudioRouting.mockClear();
      mockStopAudioRouting.mockClear();
    });

    it('calls stopAudioRouting in catch when call.answer() throws', async () => {
      mockCallStore.matrixCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type: 'voice',
        on: mockOn,
        off: mockOff,
        answer: mockAnswer,
        reject: mockReject,
        localUsermediaStream: null,
        localScreensharingStream: null,
        remoteUsermediaStream: null,
        remoteScreensharingStream: null,
        remoteUsermediaFeed: null,
      };
      mockCallStore.activeCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type: 'voice',
        direction: 'incoming',
        peerName: 'Peer',
        status: 'incoming',
      };
      mockAnswer.mockRejectedValueOnce(new Error('SDK answer deadlock'));

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.answerCall();

      await vi.waitFor(() => expect(mockStopAudioRouting).toHaveBeenCalled());
    });

    it('calls stopAudioRouting in catch when placeVoiceCall throws', async () => {
      mockPlaceVoiceCall.mockRejectedValueOnce(new Error('place failed'));

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'voice');

      expect(mockStopAudioRouting).toHaveBeenCalled();
    });

    it('calls stopAudioRouting in catch when placeVideoCall throws', async () => {
      mockPlaceVideoCall.mockRejectedValueOnce(new Error('place failed'));

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      await service.startCall('!room:matrix.org', 'video');

      expect(mockStopAudioRouting).toHaveBeenCalled();
    });

    it('does not throw even if stopAudioRouting itself rejects during catch', async () => {
      mockAnswer.mockRejectedValueOnce(new Error('answer failed'));
      mockStopAudioRouting.mockRejectedValueOnce(new Error('stop failed'));
      mockCallStore.matrixCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type: 'voice',
        on: mockOn,
        off: mockOff,
        answer: mockAnswer,
        reject: mockReject,
        localUsermediaStream: null,
        localScreensharingStream: null,
        remoteUsermediaStream: null,
        remoteScreensharingStream: null,
        remoteUsermediaFeed: null,
      };
      mockCallStore.activeCall = {
        callId: 'incoming-call-id',
        roomId: '!room:matrix.org',
        type: 'voice',
        direction: 'incoming',
        peerName: 'Peer',
        status: 'incoming',
      };

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      // Must not propagate the stopAudioRouting error to the caller —
      // UI layer can't recover from a routing cleanup failure anyway.
      await expect(service.answerCall()).resolves.toBeUndefined();
    });
  });

  describe('onAudioError listener', () => {
    it('registers onAudioError listener on module load for native', async () => {
      // Module-level code runs once at first import. Since vi.clearAllMocks()
      // clears call history, we need to re-import with a fresh module.
      vi.resetModules();
      // Re-create the addListener mock since resetModules clears module cache
      const freshAddListener = vi.fn().mockResolvedValue({ remove: vi.fn() });
      vi.doMock('@/shared/lib/native-webrtc', () => ({
        installNativeWebRTCProxy: vi.fn(),
        isNativeWebRTCEngineEnabled: () => true,
        NativeWebRTC: new Proxy({}, {
          get: (_target, prop) => {
            if (prop === 'addListener') return freshAddListener;
            return vi.fn().mockResolvedValue({});
          },
        }),
      }));

      await import('./call-service');

      const audioErrorCall = freshAddListener.mock.calls.find(
        (call: unknown[]) => call[0] === 'onAudioError'
      );
      expect(audioErrorCall).toBeTruthy();
    });
  });
});
