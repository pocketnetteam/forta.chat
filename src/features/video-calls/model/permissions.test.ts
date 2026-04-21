import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted to the top of the file by vitest
// ---------------------------------------------------------------------------

const mockRequestAudioPermission = vi.fn();
const mockRequestCameraPermission = vi.fn();

vi.mock('@/shared/lib/platform', () => ({
  isNative: true,
}));

vi.mock('@/shared/lib/native-calls', () => ({
  nativeCallBridge: {
    requestAudioPermission: mockRequestAudioPermission,
    requestCameraPermission: mockRequestCameraPermission,
  },
}));

// ---------------------------------------------------------------------------
// Native suite
// ---------------------------------------------------------------------------

describe('ensureCallPermissions (native)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('voice call, microphone granted — resolves without throwing', async () => {
    mockRequestAudioPermission.mockResolvedValue({ granted: true });
    const { ensureCallPermissions } = await import('./permissions');

    await expect(ensureCallPermissions(false)).resolves.toBeUndefined();
    expect(mockRequestAudioPermission).toHaveBeenCalledOnce();
    expect(mockRequestCameraPermission).not.toHaveBeenCalled();
  });

  it('voice call, microphone denied — throws PermissionDeniedError for microphone', async () => {
    mockRequestAudioPermission.mockResolvedValue({ granted: false });
    const { ensureCallPermissions, PermissionDeniedError } = await import('./permissions');

    await expect(ensureCallPermissions(false)).rejects.toBeInstanceOf(PermissionDeniedError);
    try {
      await ensureCallPermissions(false);
    } catch (e) {
      expect((e as InstanceType<typeof PermissionDeniedError>).device).toBe('microphone');
    }
    expect(mockRequestCameraPermission).not.toHaveBeenCalled();
  });

  it('video call, both granted — resolves', async () => {
    mockRequestAudioPermission.mockResolvedValue({ granted: true });
    mockRequestCameraPermission.mockResolvedValue({ granted: true });
    const { ensureCallPermissions } = await import('./permissions');

    await expect(ensureCallPermissions(true)).resolves.toBeUndefined();
    expect(mockRequestAudioPermission).toHaveBeenCalledOnce();
    expect(mockRequestCameraPermission).toHaveBeenCalledOnce();
  });

  it('video call, microphone granted but camera denied — throws for camera', async () => {
    mockRequestAudioPermission.mockResolvedValue({ granted: true });
    mockRequestCameraPermission.mockResolvedValue({ granted: false });
    const { ensureCallPermissions, PermissionDeniedError } = await import('./permissions');

    await expect(ensureCallPermissions(true)).rejects.toBeInstanceOf(PermissionDeniedError);
    try {
      await ensureCallPermissions(true);
    } catch (e) {
      expect((e as InstanceType<typeof PermissionDeniedError>).device).toBe('camera');
    }
  });

  it('video call, microphone denied — does not even check camera', async () => {
    mockRequestAudioPermission.mockResolvedValue({ granted: false });
    const { ensureCallPermissions } = await import('./permissions');

    await expect(ensureCallPermissions(true)).rejects.toThrow();
    expect(mockRequestCameraPermission).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PermissionDeniedError class shape
// ---------------------------------------------------------------------------

describe('PermissionDeniedError', () => {
  it('exposes device field and extends Error', async () => {
    const { PermissionDeniedError } = await import('./permissions');
    const err = new PermissionDeniedError('microphone');
    expect(err).toBeInstanceOf(Error);
    expect(err.device).toBe('microphone');
    expect(err.name).toBe('PermissionDeniedError');
    expect(err.message.toLowerCase()).toContain('microphone');
  });

  it('carries camera device correctly', async () => {
    const { PermissionDeniedError } = await import('./permissions');
    const err = new PermissionDeniedError('camera');
    expect(err.device).toBe('camera');
    expect(err.message.toLowerCase()).toContain('camera');
  });
});
