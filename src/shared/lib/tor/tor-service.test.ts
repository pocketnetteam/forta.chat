import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks for the native Tor plugin. We keep references to spy on them so each
// test can verify whether the native bridge was touched.
const mockStartDaemon = vi.fn();
const mockStopDaemon = vi.fn();
const mockConfigure = vi.fn();
const mockVerifyTor = vi.fn();
const mockClearTorCache = vi.fn();
const mockAddListener = vi.fn().mockResolvedValue({ remove: vi.fn() });
const mockIsUseWithTor = vi.fn().mockResolvedValue({ redirect: false });
const mockGetStatus = vi.fn().mockResolvedValue({ progress: 55, isReady: false, state: 'STARTING' });
const mockGetSettings = vi.fn().mockResolvedValue({
  mode: 'auto',
  bridgeType: 'NONE',
  isReady: true,
});

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    startDaemon: (...args: unknown[]) => mockStartDaemon(...args),
    stopDaemon: (...args: unknown[]) => mockStopDaemon(...args),
    getStatus: (...args: unknown[]) => mockGetStatus(...args),
    configure: (...args: unknown[]) => mockConfigure(...args),
    verifyTor: (...args: unknown[]) => mockVerifyTor(...args),
    clearTorCache: (...args: unknown[]) => mockClearTorCache(...args),
    isUseWithTor: mockIsUseWithTor,
    getSettings: mockGetSettings,
    addListener: (...args: unknown[]) => mockAddListener(...args),
  }),
}));

let mockIsNative = false;
let mockIsIOS = false;
vi.mock('@/shared/lib/platform', () => ({
  get isNative() {
    return mockIsNative;
  },
  get isIOS() {
    return mockIsIOS;
  },
}));

async function importFreshService() {
  vi.resetModules();
  const mod = await import('./tor-service');
  return mod.torService;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsNative = false;
  mockIsIOS = false;
});

afterEach(() => {
  vi.resetModules();
});

describe('TorService — iOS branch', () => {
  beforeEach(() => {
    // iOS shell — Capacitor reports native + ios platform.
    mockIsNative = true;
    mockIsIOS = true;
  });

  it('init() is a no-op that marks service ready in NEVER state', async () => {
    const torService = await importFreshService();
    await torService.init();

    expect(torService.isReady.value).toBe(true);
    expect(torService.state.value).toBe('NEVER');
    expect(mockStartDaemon).not.toHaveBeenCalled();
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('initBackground() is a no-op that marks service ready in NEVER state', async () => {
    const torService = await importFreshService();
    torService.initBackground();
    await Promise.resolve();

    expect(torService.isReady.value).toBe(true);
    expect(torService.state.value).toBe('NEVER');
    expect(mockStartDaemon).not.toHaveBeenCalled();
  });

  it('matrixBaseUrl is empty so callers fall back to direct HTTPS', async () => {
    const torService = await importFreshService();
    await torService.init();

    expect(torService.matrixBaseUrl).toBe('');
  });

  it('verify() reports tor_disabled_on_ios without calling the native bridge', async () => {
    const torService = await importFreshService();
    const result = await torService.verify();

    expect(result).toEqual({ isTor: false, ip: '', error: 'tor_disabled_on_ios' });
    expect(mockVerifyTor).not.toHaveBeenCalled();
  });

  it('stop/reconfigure/clearCache are no-ops that do not touch the native plugin', async () => {
    const torService = await importFreshService();
    await torService.stop();
    await torService.reconfigure({ mode: 'always' });
    await torService.clearCache();

    expect(mockStopDaemon).not.toHaveBeenCalled();
    expect(mockConfigure).not.toHaveBeenCalled();
    expect(mockClearTorCache).not.toHaveBeenCalled();
  });
});

/** The `stateChanged` handler of the service instance created last. */
function lastStateListener(): (e: { state: string }) => void {
  const calls = mockAddListener.mock.calls.filter(([name]) => name === 'stateChanged');
  return calls[calls.length - 1][1] as (e: { state: string }) => void;
}

describe('TorService — Android branch (regression)', () => {
  beforeEach(() => {
    mockIsNative = true;
    mockIsIOS = false;
  });

  it('init(always) starts the daemon via the native plugin', async () => {
    mockStartDaemon.mockResolvedValue({ socksPort: 9050, proxyPort: 9080, mode: 'always' });
    const torService = await importFreshService();
    await torService.init('always');

    expect(mockStartDaemon).toHaveBeenCalledWith({ mode: 'always', bridgeType: 'NONE' });
    expect(torService.isReady.value).toBe(true);
    expect(torService.matrixBaseUrl).toBe('http://127.0.0.1:9080');
  });

  // Regression: a Tor switched on in settings (off at app start) left the proxy
  // port at 0, so files skipped the TorFile plugin and the upload progress
  // sat at 0 %.
  it('reconfigure(always) takes the proxy port and exposes it once Tor runs', async () => {
    mockConfigure.mockResolvedValue({ socksPort: 9050, proxyPort: 9080 });
    const torService = await importFreshService();
    await torService.ensureListeners();
    await torService.reconfigure({ mode: 'always', bridgeType: 'NONE' });

    expect(torService.matrixBaseUrl).toBe('');
    lastStateListener()({ state: 'RUNNING' });
    expect(torService.matrixBaseUrl).toBe('http://127.0.0.1:9080');
  });

  it('reconfigure(neveruse) drops the proxy port', async () => {
    mockConfigure.mockResolvedValue({ socksPort: 9050, proxyPort: 9080 });
    const torService = await importFreshService();
    await torService.ensureListeners();
    await torService.reconfigure({ mode: 'always', bridgeType: 'NONE' });
    lastStateListener()({ state: 'RUNNING' });

    mockConfigure.mockResolvedValue({ socksPort: 0, proxyPort: 0 });
    await torService.reconfigure({ mode: 'neveruse' });

    expect(torService.matrixBaseUrl).toBe('');
  });

  it('verify() proxies to the native plugin and returns a result without error', async () => {
    mockStartDaemon.mockResolvedValue({ socksPort: 9050, proxyPort: 9080, mode: 'always' });
    mockVerifyTor.mockResolvedValue({ isTor: true, ip: '198.51.100.1' });

    const torService = await importFreshService();
    await torService.init('always');
    const result = await torService.verify();

    expect(mockVerifyTor).toHaveBeenCalledOnce();
    expect(result).toEqual({ isTor: true, ip: '198.51.100.1' });
    expect(result.error).toBeUndefined();
  });
});

describe('TorService — web/non-native branch', () => {
  it('init() resolves and marks service ready without touching the plugin', async () => {
    const torService = await importFreshService();
    await torService.init();

    expect(torService.isReady.value).toBe(true);
    expect(mockStartDaemon).not.toHaveBeenCalled();
    expect(torService.matrixBaseUrl).toBe('');
  });

  it('initBackground sets ready=true immediately on non-native', async () => {
    const torService = await importFreshService();
    torService.initBackground();
    expect(torService.isReady.value).toBe(true);
    expect(torService.initFailed.value).toBe(false);
  });

  it('initBackground accepts options object on non-native', async () => {
    const torService = await importFreshService();
    torService.initBackground({ mode: 'always', bridgeType: 'SNOWFLAKE' });
    expect(torService.isReady.value).toBe(true);
    expect(torService.mode.value).toBe('always');
    expect(torService.bridgeType.value).toBe('SNOWFLAKE');
  });

  it('init sets ready=true immediately on non-native', async () => {
    const torService = await importFreshService();
    await torService.init();
    expect(torService.isReady.value).toBe(true);
  });

  it('verify() returns the neutral empty shape (no error field)', async () => {
    const torService = await importFreshService();
    await torService.init();
    const result = await torService.verify();

    expect(result).toEqual({ isTor: false, ip: '' });
    expect(result.error).toBeUndefined();
  });

  it('clearCache is a no-op on non-native', async () => {
    const torService = await importFreshService();
    await expect(torService.clearCache()).resolves.toBeUndefined();
  });

  it('initFailed starts as false', async () => {
    const torService = await importFreshService();
    expect(torService.initFailed.value).toBe(false);
  });

  it('isUseWithTor returns false on non-native', async () => {
    const torService = await importFreshService();
    await expect(torService.isUseWithTor('https://example.com')).resolves.toBe(false);
  });

  it('getSettings returns neveruse defaults on non-native', async () => {
    const torService = await importFreshService();
    await expect(torService.getSettings()).resolves.toEqual({
      mode: 'neveruse',
      bridgeType: 'NONE',
      isReady: false,
    });
  });
});

describe('TorService — getStatus', () => {
  it('reads the native plugin on Android', async () => {
    mockIsNative = true;
    const service = await importFreshService();

    await expect(service.getStatus()).resolves.toEqual({ progress: 55, isReady: false, state: 'STARTING' });
    expect(mockGetStatus).toHaveBeenCalledOnce();
  });

  it('returns null without touching the bridge on iOS and on web', async () => {
    mockIsNative = true;
    mockIsIOS = true;
    const ios = await importFreshService();
    await expect(ios.getStatus()).resolves.toBeNull();

    mockIsNative = false;
    mockIsIOS = false;
    const web = await importFreshService();
    await expect(web.getStatus()).resolves.toBeNull();

    expect(mockGetStatus).not.toHaveBeenCalled();
  });
});
