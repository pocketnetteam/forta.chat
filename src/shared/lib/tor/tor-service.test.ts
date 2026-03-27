import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock platform as non-native by default
vi.mock('@/shared/lib/platform', () => ({
  isNative: false,
}));

// Mock Capacitor
const mockStartDaemon = vi.fn();
const mockAddListener = vi.fn().mockResolvedValue({ remove: vi.fn() });

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    startDaemon: mockStartDaemon,
    stopDaemon: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn(),
    configure: vi.fn(),
    verifyTor: vi.fn(),
    clearTorCache: vi.fn().mockResolvedValue(undefined),
    addListener: mockAddListener,
  }),
}));

describe('TorService (non-native)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('initBackground sets ready=true immediately on non-native', async () => {
    const { torService } = await import('./tor-service');
    torService.initBackground();
    expect(torService.isReady.value).toBe(true);
    expect(torService.initFailed.value).toBe(false);
  });

  it('init sets ready=true immediately on non-native', async () => {
    const { torService } = await import('./tor-service');
    await torService.init();
    expect(torService.isReady.value).toBe(true);
  });

  it('clearCache is a no-op on non-native', async () => {
    const { torService } = await import('./tor-service');
    await expect(torService.clearCache()).resolves.toBeUndefined();
  });

  it('initFailed starts as false', async () => {
    const { torService } = await import('./tor-service');
    expect(torService.initFailed.value).toBe(false);
  });

  it('matrixBaseUrl returns empty string on non-native', async () => {
    const { torService } = await import('./tor-service');
    expect(torService.matrixBaseUrl).toBe('');
  });
});
