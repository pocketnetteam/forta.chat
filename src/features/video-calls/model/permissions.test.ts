import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted to the top of the file by vitest
// ---------------------------------------------------------------------------

const mockRequestAudioPermission = vi.fn();
const mockRequestCameraPermission = vi.fn();
const mockProbeAudioAvailability = vi.fn();

vi.mock('@/shared/lib/platform', () => ({
  isNative: true,
}));

vi.mock('@/shared/lib/native-calls', () => ({
  nativeCallBridge: {
    requestAudioPermission: mockRequestAudioPermission,
    requestCameraPermission: mockRequestCameraPermission,
    probeAudioAvailability: mockProbeAudioAvailability,
  },
}));

// ---------------------------------------------------------------------------
// Native suite
// ---------------------------------------------------------------------------

describe('ensureCallPermissions (native)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: probe reports available — most tests don't care about probe.
    // Tests that test probe behavior override via mockResolvedValueOnce.
    mockProbeAudioAvailability.mockResolvedValue({ available: true });
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
// H0-preflight: probeAudioAvailability — real stream probe on native.
//
// Without this, `requestAudioPermission` may return granted=true (because the
// permission was previously granted) even though a second app (phone, voice
// recorder, MIUI privacy shield) is holding the mic OR the OEM returned a
// ghost permission and the actual AudioRecord init will fail on the next line.
// End result: SDK sends m.call.invite with an empty audio track, peer sees
// "connected" but hears silence. This probe catches that window by actually
// trying to open AudioRecord before the SDK gets involved.
// ---------------------------------------------------------------------------

describe('ensureCallPermissions — probeAudioAvailability (H0-preflight)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls probeAudioAvailability after requestAudioPermission=granted', async () => {
    mockRequestAudioPermission.mockResolvedValue({ granted: true });
    mockProbeAudioAvailability.mockResolvedValue({ available: true });
    const { ensureCallPermissions } = await import('./permissions');

    await ensureCallPermissions(false);

    expect(mockRequestAudioPermission).toHaveBeenCalledOnce();
    expect(mockProbeAudioAvailability).toHaveBeenCalledOnce();
  });

  it('throws PermissionDeniedError when probe reports audio unavailable (busy)', async () => {
    mockRequestAudioPermission.mockResolvedValue({ granted: true });
    mockProbeAudioAvailability.mockResolvedValue({
      available: false,
      hasInput: true,
      canInit: false,
    });
    const { ensureCallPermissions, PermissionDeniedError } = await import('./permissions');

    await expect(ensureCallPermissions(false)).rejects.toBeInstanceOf(PermissionDeniedError);
    try {
      await ensureCallPermissions(false);
    } catch (e) {
      const err = e as InstanceType<typeof PermissionDeniedError>;
      expect(err.device).toBe('microphone');
      expect(err.reason).toBe('audio_source_busy');
    }
  });

  it('throws PermissionDeniedError with reason=no_input_device when no mic found', async () => {
    mockRequestAudioPermission.mockResolvedValue({ granted: true });
    mockProbeAudioAvailability.mockResolvedValue({
      available: false,
      hasInput: false,
      canInit: true,
    });
    const { ensureCallPermissions, PermissionDeniedError } = await import('./permissions');

    try {
      await ensureCallPermissions(false);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as InstanceType<typeof PermissionDeniedError>;
      expect(err).toBeInstanceOf(PermissionDeniedError);
      expect(err.device).toBe('microphone');
      expect(err.reason).toBe('no_input_device');
    }
  });

  it('includes conflicting apps list in the error when available', async () => {
    mockRequestAudioPermission.mockResolvedValue({ granted: true });
    mockProbeAudioAvailability.mockResolvedValue({
      available: false,
      hasInput: true,
      canInit: false,
      conflicting: ['com.android.phone', 'com.google.android.dialer'],
    });
    const { ensureCallPermissions, PermissionDeniedError } = await import('./permissions');

    try {
      await ensureCallPermissions(false);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as InstanceType<typeof PermissionDeniedError>;
      expect(err).toBeInstanceOf(PermissionDeniedError);
      expect(err.conflicting).toEqual(['com.android.phone', 'com.google.android.dialer']);
    }
  });

  it('does not call probeAudioAvailability when permission was denied', async () => {
    mockRequestAudioPermission.mockResolvedValue({ granted: false });
    const { ensureCallPermissions } = await import('./permissions');

    await expect(ensureCallPermissions(false)).rejects.toThrow();
    expect(mockProbeAudioAvailability).not.toHaveBeenCalled();
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

  it('defaults reason to "denied" when not provided', async () => {
    const { PermissionDeniedError } = await import('./permissions');
    const err = new PermissionDeniedError('microphone');
    expect(err.reason).toBe('denied');
  });

  it('exposes reason field when provided', async () => {
    const { PermissionDeniedError } = await import('./permissions');
    const err = new PermissionDeniedError('microphone', { reason: 'audio_source_busy' });
    expect(err.reason).toBe('audio_source_busy');
  });

  it('exposes conflicting apps list when provided', async () => {
    const { PermissionDeniedError } = await import('./permissions');
    const err = new PermissionDeniedError('microphone', {
      reason: 'audio_source_busy',
      conflicting: ['com.android.phone'],
    });
    expect(err.conflicting).toEqual(['com.android.phone']);
  });
});
