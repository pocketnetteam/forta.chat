import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks ---

const mockAppGetInfo = vi.fn();
vi.mock('@capacitor/app', () => ({
  App: { getInfo: (...args: unknown[]) => mockAppGetInfo(...args) },
}));

const mockDeviceGetInfo = vi.fn();
vi.mock('@capacitor/device', () => ({
  Device: { getInfo: (...args: unknown[]) => mockDeviceGetInfo(...args) },
}));

const mockWebviewCheck = vi.fn();
vi.mock('@capgo/capacitor-webview-version-checker', () => ({
  WebviewVersionChecker: { check: (...args: unknown[]) => mockWebviewCheck(...args) },
}));

let mockPlatform: 'android' | 'ios' | 'electron' | 'web' = 'web';
let mockIsNative = false;
let mockIsAndroid = false;
let mockIsIOS = false;
vi.mock('@/shared/lib/platform', () => ({
  get currentPlatform() { return mockPlatform; },
  get isNative() { return mockIsNative; },
  get isAndroid() { return mockIsAndroid; },
  get isIOS() { return mockIsIOS; },
}));

vi.mock('@/entities/tor', () => ({
  useTorStore: () => ({ isEnabled: false, status: 'stopped', verifyResult: null }),
}));
vi.mock('@/entities/auth', () => ({
  useAuthStore: () => ({ matrixReady: false }),
}));
vi.mock('vue-router', () => ({
  useRouter: () => ({ currentRoute: { value: { fullPath: '/' } } }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mockPlatform = 'web';
  mockIsNative = false;
  mockIsAndroid = false;
  mockIsIOS = false;
});

afterEach(() => {
  vi.resetModules();
});

describe('collectEnvironment — iOS branch', () => {
  beforeEach(() => {
    mockPlatform = 'ios';
    mockIsNative = true;
    mockIsAndroid = false;
    mockIsIOS = true;
    mockAppGetInfo.mockResolvedValue({ version: '0.1.0', build: '42' });
    mockDeviceGetInfo.mockResolvedValue({
      platform: 'ios',
      osVersion: '17.4',
      manufacturer: 'Apple',
      model: 'iPhone15,2',
    });
  });

  it('reports a WKWebView label derived from the iOS version', async () => {
    vi.resetModules();
    const { collectEnvironment } = await import('../collect-environment');
    const env = await collectEnvironment();

    expect(env.platform).toBe('ios');
    expect(env.osVersion).toBe('17.4');
    expect(env.webViewVersion).toBe('WKWebView (iOS 17.4)');
    expect(env.deviceModel).toBe('Apple iPhone15,2');
    expect(mockWebviewCheck).not.toHaveBeenCalled();
  });

  it('does not fall back to the Android WebView checker', async () => {
    vi.resetModules();
    const { collectEnvironment } = await import('../collect-environment');
    await collectEnvironment();

    expect(mockWebviewCheck).not.toHaveBeenCalled();
  });
});

describe('collectEnvironment — Android branch (regression)', () => {
  beforeEach(() => {
    mockPlatform = 'android';
    mockIsNative = true;
    mockIsAndroid = true;
    mockIsIOS = false;
    mockAppGetInfo.mockResolvedValue({ version: '0.1.0', build: '42' });
    mockDeviceGetInfo.mockResolvedValue({
      platform: 'android',
      osVersion: '14',
      manufacturer: 'Google',
      model: 'Pixel 7',
    });
  });

  it('calls WebViewVersionChecker and surfaces the result', async () => {
    mockWebviewCheck.mockResolvedValue({ currentVersion: '124.0.6367.82' });

    vi.resetModules();
    const { collectEnvironment } = await import('../collect-environment');
    const env = await collectEnvironment();

    expect(mockWebviewCheck).toHaveBeenCalledOnce();
    expect(env.webViewVersion).toBe('124.0.6367.82');
  });
});
