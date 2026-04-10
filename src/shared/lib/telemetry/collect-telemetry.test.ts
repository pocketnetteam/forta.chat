import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

const mockGetInfo = vi.fn();
vi.mock('@capacitor/device', () => ({
  Device: { getInfo: (...args: unknown[]) => mockGetInfo(...args) },
}));

const mockCheck = vi.fn();
vi.mock('@capgo/capacitor-webview-version-checker', () => ({
  WebviewVersionChecker: { check: (...args: unknown[]) => mockCheck(...args) },
}));

let mockIsAndroid = false;
vi.mock('@/shared/lib/platform', () => ({
  get isAndroid() {
    return mockIsAndroid;
  },
}));

// --- Helpers ---

function makeDeviceInfo(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'android',
    model: 'Pixel 7',
    manufacturer: 'Google',
    osVersion: '14',
    androidSDKVersion: 34,
    ...overrides,
  };
}

// --- Tests ---

describe('collectTelemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAndroid = false;
    mockGetInfo.mockResolvedValue(makeDeviceInfo());

    // Provide screen globals for happy-dom
    Object.defineProperty(window, 'screen', {
      value: { width: 1080, height: 2400 },
      writable: true,
    });
    Object.defineProperty(window, 'devicePixelRatio', {
      value: 2.75,
      writable: true,
    });
  });

  it('returns TelemetrySnapshot with all required fields', async () => {
    const { collectTelemetry } = await import('./collect-telemetry');
    const snap = await collectTelemetry();

    expect(snap).toMatchObject({
      platform: 'android',
      deviceModel: 'Pixel 7',
      deviceManufacturer: 'Google',
      androidVersion: '14',
      androidSdk: 34,
      screenWidth: 1080,
      screenHeight: 2400,
      screenDpr: 2.75,
    });
    expect(typeof snap.collectedAt).toBe('number');
    expect(snap.webViewVersion).toBeNull();
    expect(snap.webViewMajor).toBeNull();
    expect(snap.webViewState).toBeNull();
  });

  it('on Android, calls WebViewVersionChecker and populates webView fields', async () => {
    mockIsAndroid = true;
    mockCheck.mockResolvedValue({
      currentVersion: '124.0.6367.82',
      currentMajorVersion: 124,
      state: 'outdated',
    });

    // Re-import to pick up changed mock
    vi.resetModules();
    const { collectTelemetry } = await import('./collect-telemetry');
    const snap = await collectTelemetry();

    expect(mockCheck).toHaveBeenCalledOnce();
    expect(snap.webViewVersion).toBe('124.0.6367.82');
    expect(snap.webViewMajor).toBe(124);
    expect(snap.webViewState).toBe('outdated');
  });

  it('on non-Android, webView fields are null and checker is not called', async () => {
    mockIsAndroid = false;

    vi.resetModules();
    const { collectTelemetry } = await import('./collect-telemetry');
    const snap = await collectTelemetry();

    expect(mockCheck).not.toHaveBeenCalled();
    expect(snap.webViewVersion).toBeNull();
    expect(snap.webViewMajor).toBeNull();
    expect(snap.webViewState).toBeNull();
  });

  it('does not throw when WebViewVersionChecker.check() throws', async () => {
    mockIsAndroid = true;
    mockCheck.mockRejectedValue(new Error('Plugin not available'));

    vi.resetModules();
    const { collectTelemetry } = await import('./collect-telemetry');
    const snap = await collectTelemetry();

    expect(snap.webViewVersion).toBeNull();
    expect(snap.webViewMajor).toBeNull();
    expect(snap.webViewState).toBeNull();
  });

  it('logs snapshot with [Telemetry] prefix', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    vi.resetModules();
    const { collectTelemetry } = await import('./collect-telemetry');
    await collectTelemetry();

    expect(infoSpy).toHaveBeenCalledWith(
      '[Telemetry]',
      expect.any(String),
    );
    const jsonArg = infoSpy.mock.calls[0][1] as string;
    expect(() => JSON.parse(jsonArg)).not.toThrow();

    infoSpy.mockRestore();
  });
});
