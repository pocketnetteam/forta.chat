// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  mockCallStore,
} from './call-service.harness';

// Regression: a fresh getUserMedia track starts enabled and the SDK mutes by
// disabling the track, so switching the mic (or camera) while muted put the
// user back on air while the button still said "muted".
describe('device switch keeps the mute state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setup(kind: 'audio' | 'video', muted: boolean) {
    const newTrack = { kind, enabled: true, stop: vi.fn() };
    const replaceTrack = vi.fn().mockResolvedValue(undefined);
    const oldTrack = { kind, enabled: !muted, stop: vi.fn() };
    const localStream = {
      getAudioTracks: () => (kind === 'audio' ? [oldTrack] : []),
      getVideoTracks: () => (kind === 'video' ? [oldTrack] : []),
      removeTrack: vi.fn(),
      addTrack: vi.fn(),
    };
    mockCallStore.matrixCall = {
      isMicrophoneMuted: vi.fn(() => kind === 'audio' && muted),
      isLocalVideoMuted: vi.fn(() => kind === 'video' && muted),
      peerConn: { getSenders: () => [{ track: oldTrack, replaceTrack }] },
      localUsermediaStream: localStream,
      getFeeds: () => [],
      getLocalFeeds: () => [],
      getRemoteFeeds: () => [],
    };
    const stream = {
      getAudioTracks: () => (kind === 'audio' ? [newTrack] : []),
      getVideoTracks: () => (kind === 'video' ? [newTrack] : []),
      getTracks: () => [newTrack],
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    return { newTrack, replaceTrack };
  }

  it('a muted mic stays muted on the new device', async () => {
    const { newTrack, replaceTrack } = setup('audio', true);
    const { useCallService } = await import('./call-service');
    await useCallService().setAudioDevice('mic-2');
    expect(replaceTrack).toHaveBeenCalledWith(newTrack);
    expect(newTrack.enabled).toBe(false);
  });

  it('a live mic stays live on the new device', async () => {
    const { newTrack } = setup('audio', false);
    const { useCallService } = await import('./call-service');
    await useCallService().setAudioDevice('mic-2');
    expect(newTrack.enabled).toBe(true);
  });

  it('a camera turned off stays off on the new device', async () => {
    const { newTrack, replaceTrack } = setup('video', true);
    const { useCallService } = await import('./call-service');
    await useCallService().setVideoDevice('cam-2');
    expect(replaceTrack).toHaveBeenCalledWith(newTrack);
    expect(newTrack.enabled).toBe(false);
  });
});
