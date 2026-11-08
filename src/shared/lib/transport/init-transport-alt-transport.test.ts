import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const platform = vi.hoisted(() => ({ isAndroid: false, isNative: false }));
const isUseWithTor = vi.hoisted(() => vi.fn());

vi.mock('@/shared/lib/platform', () => ({
  get isAndroid() { return platform.isAndroid; },
  get isNative() { return platform.isNative; },
}));

vi.mock('@/shared/lib/tor', () => ({
  torService: { isUseWithTor },
}));

/** In-memory BroadcastChannel: a real one keeps the worker's event loop alive. */
class FakeBroadcastChannel {
  static channels: FakeBroadcastChannel[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;

  constructor(readonly name: string) {
    FakeBroadcastChannel.channels.push(this);
  }

  postMessage(data: unknown) {
    for (const ch of FakeBroadcastChannel.channels) {
      if (ch !== this && ch.name === this.name) ch.onmessage?.({ data });
    }
  }

  close() {}
}

const API_URL = 'https://api.bastyon.com/rpc';

function stubElectronBridge(invoke: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('window', { fetchBridge: { invoke, send: vi.fn(), on: vi.fn() } });
}

beforeEach(() => {
  platform.isAndroid = false;
  platform.isNative = false;
  isUseWithTor.mockReset();
  FakeBroadcastChannel.channels = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveUsesTor', () => {
  it('sends whitelisted hosts direct without asking the platform', async () => {
    const invoke = vi.fn();
    stubElectronBridge(invoke);
    const { resolveUsesTor } = await import('./init-transport');

    expect(await resolveUsesTor('https://www.youtube.com/watch?v=1')).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('Electron: asks the main process over AltTransportActive', async () => {
    const invoke = vi.fn().mockResolvedValue(true);
    stubElectronBridge(invoke);
    const { resolveUsesTor } = await import('./init-transport');

    expect(await resolveUsesTor(API_URL)).toBe(true);
    expect(invoke).toHaveBeenCalledWith('AltTransportActive', API_URL);
  });

  it('Electron: coerces an empty answer to false', async () => {
    stubElectronBridge(vi.fn().mockResolvedValue(undefined));
    const { resolveUsesTor } = await import('./init-transport');

    expect(await resolveUsesTor(API_URL)).toBe(false);
  });

  it('Electron: throws when the preload did not expose fetchBridge', async () => {
    vi.stubGlobal('window', {});
    const { resolveUsesTor } = await import('./init-transport');

    await expect(resolveUsesTor(API_URL)).rejects.toThrow('fetchBridge is not available');
  });

  it('Android: asks the native Tor plugin, not the Electron bridge', async () => {
    platform.isAndroid = true;
    platform.isNative = true;
    const invoke = vi.fn();
    stubElectronBridge(invoke);
    isUseWithTor.mockResolvedValue(true);
    const { resolveUsesTor } = await import('./init-transport');

    expect(await resolveUsesTor(API_URL)).toBe(true);
    expect(isUseWithTor).toHaveBeenCalledWith(API_URL);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('AltTransportActive service-worker handler', () => {
  async function startAndroidTransport() {
    platform.isAndroid = true;
    platform.isNative = true;
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal('location', { protocol: 'https:' });
    vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn().mockResolvedValue({}) } });
    const { initNativeTransport } = await import('./init-transport');
    await initNativeTransport();
    return new FakeBroadcastChannel('ServiceWorker');
  }

  function ask(sw: FakeBroadcastChannel, id: string, url: string): Promise<unknown> {
    return new Promise((resolve) => {
      sw.onmessage = ({ data }) => {
        const msg = data as { name: string; data: unknown };
        if (msg.name === `AltTransportActive_result[${id}]`) resolve(msg.data);
      };
      sw.postMessage({ name: 'AltTransportActive', data: { id, data: url } });
    });
  }

  it('answers the service worker under the request id', async () => {
    isUseWithTor.mockResolvedValue(true);
    const sw = await startAndroidTransport();

    expect(await ask(sw, '42', API_URL)).toBe(true);
  });

  it('answers direct when the platform check fails', async () => {
    isUseWithTor.mockRejectedValue(new Error('plugin gone'));
    const sw = await startAndroidTransport();

    expect(await ask(sw, '7', API_URL)).toBe(false);
  });

  it('ignores unrelated service-worker messages', async () => {
    const sw = await startAndroidTransport();

    sw.postMessage({ name: 'network-stats', data: {} });

    expect(isUseWithTor).not.toHaveBeenCalled();
  });
});
