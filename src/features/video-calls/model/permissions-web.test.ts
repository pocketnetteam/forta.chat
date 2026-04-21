import { describe, it, expect, vi, beforeEach } from 'vitest';

// On web path, nativeCallBridge is not invoked at all — ensureCallPermissions
// goes through navigator.permissions and navigator.mediaDevices.getUserMedia.

vi.mock('@/shared/lib/platform', () => ({
  isNative: false,
}));

vi.mock('@/shared/lib/native-calls', () => ({
  nativeCallBridge: {
    requestAudioPermission: vi.fn(),
    requestCameraPermission: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Fake navigator helpers
// ---------------------------------------------------------------------------

interface PermissionEntry {
  state: 'granted' | 'denied' | 'prompt';
}

function installNavigatorMocks(opts: {
  permissions?: Record<string, PermissionEntry>;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}) {
  const permsMap = opts.permissions ?? {};
  (globalThis as unknown as { navigator: Navigator }).navigator = {
    permissions: {
      query: vi.fn(async (q: { name: string }) => {
        const entry = permsMap[q.name] ?? { state: 'prompt' };
        return entry as unknown as PermissionStatus;
      }),
    },
    mediaDevices: {
      getUserMedia: opts.getUserMedia ?? vi.fn(),
    },
  } as unknown as Navigator;
}

function makeStream(audioTracks: number, videoTracks: number): MediaStream {
  const stopSpy = vi.fn();
  const audio = Array.from({ length: audioTracks }, () => ({
    kind: 'audio',
    stop: stopSpy,
  }));
  const video = Array.from({ length: videoTracks }, () => ({
    kind: 'video',
    stop: stopSpy,
  }));
  return {
    getAudioTracks: () => audio,
    getVideoTracks: () => video,
    getTracks: () => [...audio, ...video],
  } as unknown as MediaStream;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensureCallPermissions (web)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mic permission state=denied — throws microphone denied', async () => {
    installNavigatorMocks({
      permissions: { microphone: { state: 'denied' } },
      getUserMedia: vi.fn().mockResolvedValue(makeStream(1, 0)),
    });

    const { ensureCallPermissions, PermissionDeniedError } = await import('./permissions');
    await expect(ensureCallPermissions(false)).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('mic granted, getUserMedia yields a valid audio track — resolves', async () => {
    const stream = makeStream(1, 0);
    installNavigatorMocks({
      permissions: { microphone: { state: 'granted' } },
      getUserMedia: vi.fn().mockResolvedValue(stream),
    });

    const { ensureCallPermissions } = await import('./permissions');
    await expect(ensureCallPermissions(false)).resolves.toBeUndefined();
  });

  it('getUserMedia returns stream with 0 audio tracks — treats as denied', async () => {
    installNavigatorMocks({
      permissions: { microphone: { state: 'granted' } },
      getUserMedia: vi.fn().mockResolvedValue(makeStream(0, 0)),
    });

    const { ensureCallPermissions, PermissionDeniedError } = await import('./permissions');
    await expect(ensureCallPermissions(false)).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('getUserMedia throws NotAllowedError — maps to PermissionDeniedError for microphone', async () => {
    const err = new Error('Permission denied by user');
    err.name = 'NotAllowedError';
    installNavigatorMocks({
      permissions: { microphone: { state: 'prompt' } },
      getUserMedia: vi.fn().mockRejectedValue(err),
    });

    const { ensureCallPermissions, PermissionDeniedError } = await import('./permissions');
    await expect(ensureCallPermissions(false)).rejects.toSatisfy((e: unknown) => {
      return e instanceof PermissionDeniedError &&
        (e as InstanceType<typeof PermissionDeniedError>).device === 'microphone';
    });
  });

  it('video call, microphone denied via NotAllowedError — attributes to microphone (NOT camera)', async () => {
    // Regression: a combined getUserMedia({audio,video}) would lose the
    // device attribution and always label denials as "camera" on video
    // calls. Sequential probing must attribute this to microphone.
    const err = new Error('Permission denied by user');
    err.name = 'NotAllowedError';
    const getUserMedia = vi.fn((constraints: MediaStreamConstraints) => {
      // First call is audio-only — fail it with NotAllowedError.
      if (constraints.audio && !constraints.video) return Promise.reject(err);
      return Promise.resolve(makeStream(0, 1));
    });
    installNavigatorMocks({
      permissions: {
        microphone: { state: 'prompt' },
        camera: { state: 'granted' },
      },
      getUserMedia,
    });

    const { ensureCallPermissions, PermissionDeniedError } = await import('./permissions');
    await expect(ensureCallPermissions(true)).rejects.toSatisfy((e: unknown) => {
      return e instanceof PermissionDeniedError &&
        (e as InstanceType<typeof PermissionDeniedError>).device === 'microphone';
    });
    // Only the audio probe should have been attempted; video probe is skipped.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('video call, camera denied via NotAllowedError on the video probe — attributes to camera', async () => {
    const err = new Error('Permission denied by user');
    err.name = 'NotAllowedError';
    const getUserMedia = vi.fn((constraints: MediaStreamConstraints) => {
      if (constraints.audio && !constraints.video) {
        // Audio probe succeeds.
        return Promise.resolve(makeStream(1, 0));
      }
      // Video probe fails.
      return Promise.reject(err);
    });
    installNavigatorMocks({
      permissions: {
        microphone: { state: 'granted' },
        camera: { state: 'prompt' },
      },
      getUserMedia,
    });

    const { ensureCallPermissions, PermissionDeniedError } = await import('./permissions');
    await expect(ensureCallPermissions(true)).rejects.toSatisfy((e: unknown) => {
      return e instanceof PermissionDeniedError &&
        (e as InstanceType<typeof PermissionDeniedError>).device === 'camera';
    });
  });

  it('video call, camera denied via permissions query — throws camera', async () => {
    installNavigatorMocks({
      permissions: {
        microphone: { state: 'granted' },
        camera: { state: 'denied' },
      },
      getUserMedia: vi.fn().mockResolvedValue(makeStream(1, 1)),
    });

    const { ensureCallPermissions, PermissionDeniedError } = await import('./permissions');
    await expect(ensureCallPermissions(true)).rejects.toSatisfy((e: unknown) => {
      return e instanceof PermissionDeniedError &&
        (e as InstanceType<typeof PermissionDeniedError>).device === 'camera';
    });
  });

  it('video call, getUserMedia returns stream without video tracks — throws camera', async () => {
    installNavigatorMocks({
      permissions: {
        microphone: { state: 'granted' },
        camera: { state: 'granted' },
      },
      // 0 video tracks — camera did not actually deliver
      getUserMedia: vi.fn().mockResolvedValue(makeStream(1, 0)),
    });

    const { ensureCallPermissions, PermissionDeniedError } = await import('./permissions');
    await expect(ensureCallPermissions(true)).rejects.toSatisfy((e: unknown) => {
      return e instanceof PermissionDeniedError &&
        (e as InstanceType<typeof PermissionDeniedError>).device === 'camera';
    });
  });

  it('video call, everything granted and tracks present — resolves', async () => {
    installNavigatorMocks({
      permissions: {
        microphone: { state: 'granted' },
        camera: { state: 'granted' },
      },
      getUserMedia: vi.fn().mockResolvedValue(makeStream(1, 1)),
    });

    const { ensureCallPermissions } = await import('./permissions');
    await expect(ensureCallPermissions(true)).resolves.toBeUndefined();
  });

  it('stops tracks from the probe stream to release device', async () => {
    const stream = makeStream(1, 0);
    const stopSpy = vi.fn();
    (stream.getTracks() as Array<{ stop: () => void }>).forEach((t) => {
      t.stop = stopSpy;
    });

    installNavigatorMocks({
      permissions: { microphone: { state: 'granted' } },
      getUserMedia: vi.fn().mockResolvedValue(stream),
    });

    const { ensureCallPermissions } = await import('./permissions');
    await ensureCallPermissions(false);
    expect(stopSpy).toHaveBeenCalled();
  });
});
