// @vitest-environment happy-dom
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

vi.mock('@/shared/lib/platform', () => ({
  isNative: true,
  isIOS: false,
}));

vi.mock('./push-data-plugin', () => ({
  PushData: {
    isFcmAvailable: vi.fn().mockResolvedValue({ available: true }),
    cacheRoomNames: vi.fn().mockResolvedValue(undefined),
    cacheSenderNames: vi.fn().mockResolvedValue(undefined),
    cancelNotification: vi.fn().mockResolvedValue(undefined),
    cancelAllMessageNotifications: vi.fn().mockResolvedValue(undefined),
    replaceNotificationContent: vi.fn().mockResolvedValue(undefined),
    getPendingIntent: vi.fn().mockResolvedValue({}),
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
    onPusherRegistered: vi.fn().mockResolvedValue({}),
    clearLegacyFcmToken: vi.fn().mockResolvedValue(undefined),
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
      matrixClient: unknown;
      registerPusher: (c: typeof client, t: string) => Promise<void>;
    };
    svc.matrixClient = client; // init() sets the client before any registration event
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
    localStorage.setItem('push_own_pushkey', 'old-own-token');
    const client = {
      setPusher: vi.fn().mockResolvedValue(undefined),
      getPushers: vi.fn().mockRejectedValue(new Error('cleanup failed')),
    };
    await expect(callRegisterPusher(client)).resolves.toBeUndefined();
    expect(client.setPusher).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('push_pusher_dead_letter')).toBeNull();
  });

  // Regression: the VoIP pusher was PUT once; iOS delivers the token once per
  // launch, so one transient failure meant no CallKit ring until relaunch.
  it('drops a pending pusher retry when the account logged out during the backoff', async () => {
    const client = {
      setPusher: vi.fn().mockRejectedValueOnce(new Error('network blip')).mockResolvedValue(undefined),
      getPushers: vi.fn().mockResolvedValue({ pushers: [] }),
    };
    const mod = await import('./push-service');
    const svc = mod.pushService as unknown as { matrixClient: unknown };
    const promise = callRegisterPusher(client);
    await vi.advanceTimersByTimeAsync(0);
    svc.matrixClient = null; // what unregisterForLogout does first
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    expect(client.setPusher).toHaveBeenCalledTimes(1);
    expect(client.getPushers).not.toHaveBeenCalled();
    expect(localStorage.getItem('push_pusher_dead_letter')).toBeNull();
  });

  it('takes back a pusher whose registration landed after logout', async () => {
    let land!: () => void;
    const client = {
      setPusher: vi.fn()
        .mockImplementationOnce(() => new Promise<void>((r) => { land = r; }))
        .mockResolvedValue(undefined),
      getPushers: vi.fn().mockResolvedValue({ pushers: [] }),
    };
    const mod = await import('./push-service');
    const svc = mod.pushService as unknown as { matrixClient: unknown };
    const promise = callRegisterPusher(client);
    await vi.advanceTimersByTimeAsync(0);
    svc.matrixClient = null; // logout ran while the PUT was in flight
    land();
    await promise;
    expect(client.setPusher).toHaveBeenCalledTimes(2);
    expect(client.setPusher.mock.calls[1][0]).toMatchObject({ pushkey: 'token-abc', kind: null });
    expect(client.getPushers).not.toHaveBeenCalled();
  });

  // Review 2026-10-08: a logout and a fresh login to the same account on this
  // device register the same pushkey, so the late take-back deleted the new
  // session's pusher.
  it('keeps a late pusher when the same account signed in again meanwhile', async () => {
    let land!: () => void;
    const client = {
      getUserId: () => '@alice:server',
      setPusher: vi.fn()
        .mockImplementationOnce(() => new Promise<void>((r) => { land = r; }))
        .mockResolvedValue(undefined),
      getPushers: vi.fn().mockResolvedValue({ pushers: [] }),
    };
    const mod = await import('./push-service');
    const svc = mod.pushService as unknown as { matrixClient: unknown };
    const promise = callRegisterPusher(client);
    await vi.advanceTimersByTimeAsync(0);
    svc.matrixClient = { getUserId: () => '@alice:server' }; // logout, then the same account again
    land();
    await promise;
    expect(client.setPusher).toHaveBeenCalledTimes(1);
  });

  it('takes back a VoIP pusher whose registration landed after logout (review 2026-10-08, P2)', async () => {
    let land!: () => void;
    const client = {
      setPusher: vi.fn()
        .mockImplementationOnce(() => new Promise<void>((r) => { land = r; }))
        .mockResolvedValue(undefined),
      getPushers: vi.fn().mockResolvedValue({ pushers: [] }),
    };
    const mod = await import('./push-service');
    const svc = mod.pushService as unknown as {
      matrixClient: unknown;
      registerVoipPusher: (c: typeof client, t: string) => Promise<void>;
    };
    svc.matrixClient = client;
    const promise = svc.registerVoipPusher(client, 'voip-late');
    await vi.advanceTimersByTimeAsync(0);
    svc.matrixClient = null; // logout ran while the PUT was in flight
    land();
    await promise;
    expect(client.setPusher).toHaveBeenCalledTimes(2);
    expect(client.setPusher.mock.calls[1][0]).toMatchObject({ pushkey: 'voip-late', kind: null });
  });

  it('does not register a VoIP pusher for a client that is no longer signed in', async () => {
    const client = {
      setPusher: vi.fn().mockResolvedValue(undefined),
      getPushers: vi.fn().mockResolvedValue({ pushers: [] }),
    };
    const mod = await import('./push-service');
    const svc = mod.pushService as unknown as {
      matrixClient: unknown;
      registerVoipPusher: (c: typeof client, t: string) => Promise<void>;
    };
    svc.matrixClient = null; // logout landed while init() awaited the VoIP token
    await svc.registerVoipPusher(client, 'voip-stale');
    expect(client.setPusher).not.toHaveBeenCalled();
  });

  it('retries the VoIP pusher registration on transient failure', async () => {
    const client = {
      setPusher: vi.fn().mockRejectedValueOnce(new Error('network blip')).mockResolvedValue(undefined),
      getPushers: vi.fn().mockResolvedValue({ pushers: [] }),
    };
    const mod = await import('./push-service');
    const svc = mod.pushService as unknown as {
      matrixClient: unknown;
      registerVoipPusher: (c: typeof client, t: string) => Promise<void>;
    };
    svc.matrixClient = client;
    const promise = svc.registerVoipPusher(client, 'voip-abc');
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    expect(client.setPusher).toHaveBeenCalledTimes(2);
    expect(client.getPushers).toHaveBeenCalledTimes(1);
  });

  it('drops a pending VoIP pusher retry when the account logged out during the backoff', async () => {
    const client = {
      setPusher: vi.fn().mockRejectedValueOnce(new Error('network blip')).mockResolvedValue(undefined),
      getPushers: vi.fn().mockResolvedValue({ pushers: [] }),
    };
    const mod = await import('./push-service');
    const svc = mod.pushService as unknown as {
      matrixClient: unknown;
      registerVoipPusher: (c: typeof client, t: string) => Promise<void>;
    };
    svc.matrixClient = client;
    const promise = svc.registerVoipPusher(client, 'voip-abc');
    await vi.advanceTimersByTimeAsync(0);
    svc.matrixClient = null; // what unregisterForLogout does first
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    expect(client.setPusher).toHaveBeenCalledTimes(1);
    expect(client.getPushers).not.toHaveBeenCalled();
  });
});

// A change of Firebase project (fortaandroid <-> fortaandroid2, see
// docs/plans/2026-10-14-firebase-fortachat-migration.md) leaves the device's
// old pusher (other app_id, old token) on the homeserver next to the new one,
// and every message rang twice.
describe('PushService.registerPusher legacy pusher removal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  async function register(client: { setPusher: ReturnType<typeof vi.fn>; getPushers: ReturnType<typeof vi.fn> }) {
    const mod = await import('./push-service');
    const svc = mod.pushService as unknown as {
      matrixClient: unknown;
      registerPusher: (c: typeof client, t: string) => Promise<void>;
    };
    svc.matrixClient = client; // init() sets the client before any registration event
    return svc.registerPusher(client, 'new-token');
  }

  it('removes the old-project pusher of this device once the new one is registered', async () => {
    const { PushData } = await import('./push-data-plugin');
    vi.mocked(PushData.onPusherRegistered).mockResolvedValueOnce({ legacyToken: 'old-token' });
    const oldPusher = { app_id: 'fortaandroid2', pushkey: 'old-token', kind: 'http' };
    const otherDevice = { app_id: 'fortaandroid2', pushkey: 'other-device', kind: 'http' };
    const client = {
      setPusher: vi.fn().mockResolvedValue(undefined),
      getPushers: vi.fn().mockResolvedValue({ pushers: [oldPusher, otherDevice] }),
    };

    await register(client);

    expect(PushData.onPusherRegistered).toHaveBeenCalledWith({ token: 'new-token' });
    expect(client.setPusher).toHaveBeenNthCalledWith(1, expect.objectContaining({ app_id: 'fortaandroid', pushkey: 'new-token' }));
    expect(client.setPusher).toHaveBeenCalledWith({ ...oldPusher, kind: null });
    expect(client.setPusher).not.toHaveBeenCalledWith(expect.objectContaining({ pushkey: 'other-device', kind: null }));
    expect(PushData.clearLegacyFcmToken).toHaveBeenCalledWith({ token: 'old-token' });
  });

  it('keeps the legacy token for the next boot when the removal fails', async () => {
    const { PushData } = await import('./push-data-plugin');
    vi.mocked(PushData.onPusherRegistered).mockResolvedValueOnce({ legacyToken: 'old-token' });
    vi.mocked(PushData.clearLegacyFcmToken).mockClear();
    const client = {
      setPusher: vi.fn().mockResolvedValue(undefined),
      getPushers: vi.fn().mockRejectedValue(new Error('offline')),
    };

    await expect(register(client)).resolves.toBeUndefined();
    expect(PushData.clearLegacyFcmToken).not.toHaveBeenCalled();
  });

  it('still registers when native lacks onPusherRegistered', async () => {
    const { PushData } = await import('./push-data-plugin');
    vi.mocked(PushData.onPusherRegistered).mockRejectedValueOnce(new Error('UNIMPLEMENTED'));
    const client = {
      setPusher: vi.fn().mockResolvedValue(undefined),
      getPushers: vi.fn().mockResolvedValue({ pushers: [] }),
    };

    await register(client);

    expect(client.setPusher).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('push_pusher_dead_letter')).toBeNull();
  });
});

// Two Android phones on one account register under the same app_id. The old
// cleanup removed every pusher with that app_id and another token, so each
// phone deleted the other's pusher on start and only the last one opened got
// pushes.
describe('PushService pusher cleanup leaves other devices of the account alone', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  type Client = { setPusher: ReturnType<typeof vi.fn>; getPushers: ReturnType<typeof vi.fn> };

  async function service(client: Client) {
    const mod = await import('./push-service');
    const svc = mod.pushService as unknown as {
      matrixClient: unknown;
      registerPusher: (c: Client, t: string) => Promise<void>;
      registerVoipPusher: (c: Client, t: string) => Promise<void>;
    };
    svc.matrixClient = client; // init() sets the client before any registration event
    return svc;
  }

  const otherPhone = { app_id: 'fortaandroid', pushkey: 'other-phone-token', kind: 'http' };

  it('keeps the pusher of another phone with the same app_id', async () => {
    const client: Client = {
      setPusher: vi.fn().mockResolvedValue(undefined),
      getPushers: vi.fn().mockResolvedValue({ pushers: [otherPhone] }),
    };

    await (await service(client)).registerPusher(client, 'my-token');

    expect(client.setPusher).toHaveBeenCalledTimes(1);
    expect(client.setPusher).not.toHaveBeenCalledWith(expect.objectContaining({ kind: null }));
    expect(localStorage.getItem('push_own_pushkey')).toBe('my-token');
  });

  it('removes only the pusher of this device\'s previous token', async () => {
    localStorage.setItem('push_own_pushkey', 'my-old-token');
    const myOld = { app_id: 'fortaandroid', pushkey: 'my-old-token', kind: 'http' };
    const client: Client = {
      setPusher: vi.fn().mockResolvedValue(undefined),
      getPushers: vi.fn().mockResolvedValue({ pushers: [myOld, otherPhone] }),
    };

    await (await service(client)).registerPusher(client, 'my-token');

    expect(client.setPusher).toHaveBeenCalledWith({ ...myOld, kind: null });
    expect(client.setPusher).not.toHaveBeenCalledWith(expect.objectContaining({ pushkey: 'other-phone-token', kind: null }));
    expect(localStorage.getItem('push_own_pushkey')).toBe('my-token');
  });

  it('keeps the previous token for the next boot when the removal fails', async () => {
    localStorage.setItem('push_own_pushkey', 'my-old-token');
    const client: Client = {
      setPusher: vi.fn().mockResolvedValue(undefined),
      getPushers: vi.fn().mockRejectedValue(new Error('offline')),
    };

    await (await service(client)).registerPusher(client, 'my-token');

    expect(localStorage.getItem('push_own_pushkey')).toBe('my-old-token');
  });

  it('VoIP: removes this iPhone\'s previous VoIP pusher, keeps another iPhone\'s', async () => {
    localStorage.setItem('push_own_voip_pushkey', 'my-old-voip');
    const myOld = { app_id: 'fortaios.voip', pushkey: 'my-old-voip', kind: 'http' };
    const otherIphone = { app_id: 'fortaios.voip', pushkey: 'other-iphone-voip', kind: 'http' };
    const client: Client = {
      setPusher: vi.fn().mockResolvedValue(undefined),
      getPushers: vi.fn().mockResolvedValue({ pushers: [myOld, otherIphone] }),
    };

    await (await service(client)).registerVoipPusher(client, 'my-voip');

    expect(client.setPusher).toHaveBeenCalledWith({ ...myOld, kind: null });
    expect(client.setPusher).not.toHaveBeenCalledWith(expect.objectContaining({ pushkey: 'other-iphone-voip', kind: null }));
    expect(localStorage.getItem('push_own_voip_pushkey')).toBe('my-voip');
  });
});
