import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The push service module has a non-trivial import surface (Capacitor
// plugins, i18n, native bridge) — for retry behaviour we only need to
// exercise registerPusher in isolation. Stub the heavy imports first so
// `import('./push-service')` doesn't blow up under happy-dom.
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    requestPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    register: vi.fn().mockResolvedValue(undefined),
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
    removeAllListeners: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    requestPermissions: vi.fn().mockResolvedValue({ display: 'granted' }),
    createChannel: vi.fn().mockResolvedValue(undefined),
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  },
}));

vi.mock('@/shared/lib/platform', () => ({
  isNative: true,
}));

vi.mock('./push-data-plugin', () => ({
  PushData: {
    cacheRoomNames: vi.fn().mockResolvedValue(undefined),
    cacheSenderNames: vi.fn().mockResolvedValue(undefined),
    cancelNotification: vi.fn().mockResolvedValue(undefined),
    cancelAllMessageNotifications: vi.fn().mockResolvedValue(undefined),
    replaceNotificationContent: vi.fn().mockResolvedValue(undefined),
    getPendingIntent: vi.fn().mockResolvedValue({}),
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  },
}));

vi.mock('@/shared/lib/i18n', () => ({
  tRaw: (k: string) => k,
}));

describe('PushService.registerPusher retry behaviour', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Helper: invoke the private `registerPusher` through the live instance.
   *  Access modifiers are TS-only; at runtime the method is on the
   *  prototype and reachable via an unknown cast. */
  async function callRegisterPusher(client: { setPusher: ReturnType<typeof vi.fn>; getPushers: ReturnType<typeof vi.fn> }) {
    const mod = await import('./push-service');
    const svc = mod.pushService as unknown as {
      registerPusher: (c: typeof client, t: string) => Promise<void>;
    };
    return svc.registerPusher(client, 'token-abc');
  }

  it('succeeds on the first attempt and does not retry', async () => {
    const client = {
      setPusher: vi.fn().mockResolvedValue(undefined),
      getPushers: vi.fn().mockResolvedValue({ pushers: [] }),
    };
    await callRegisterPusher(client);
    expect(client.setPusher).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('push_pusher_dead_letter')).toBeNull();
  });

  it('retries on transient failure and eventually succeeds', async () => {
    const client = {
      setPusher: vi
        .fn()
        .mockRejectedValueOnce(new Error('network blip'))
        .mockResolvedValueOnce(undefined),
      getPushers: vi.fn().mockResolvedValue({ pushers: [] }),
    };
    const promise = callRegisterPusher(client);
    // Run the 1s backoff timer
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    expect(client.setPusher).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('push_pusher_dead_letter')).toBeNull();
  });

  it('writes dead-letter to localStorage after 3 exhausted attempts', async () => {
    const client = {
      setPusher: vi.fn().mockRejectedValue(new Error('server unreachable')),
      getPushers: vi.fn().mockResolvedValue({ pushers: [] }),
    };
    const promise = callRegisterPusher(client);
    // 1s + 2s of backoffs between attempts
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    expect(client.setPusher).toHaveBeenCalledTimes(3);

    const raw = localStorage.getItem('push_pusher_dead_letter');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.token).toBe('token-abc');
    expect(typeof parsed.at).toBe('number');
    expect(parsed.error).toContain('server unreachable');
  });

  it('does not abort registration when stale-pusher cleanup fails', async () => {
    // Primary setPusher succeeds; getPushers (used by cleanup) throws.
    const client = {
      setPusher: vi.fn().mockResolvedValue(undefined),
      getPushers: vi.fn().mockRejectedValue(new Error('cleanup failed')),
    };
    await expect(callRegisterPusher(client)).resolves.toBeUndefined();
    expect(client.setPusher).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('push_pusher_dead_letter')).toBeNull();
  });
});
