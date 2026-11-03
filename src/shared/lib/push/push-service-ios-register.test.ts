import { describe, it, expect, vi, beforeEach } from 'vitest';

// iOS: the FCM-availability probe is an Android plugin method. On iOS the
// PushData plugin is IOSPushIntentPlugin, which rejects the call with
// UNIMPLEMENTED, and the service used to treat that as "FCM not configured"
// and return before registering for APNs or wiring the VoIP token. The
// probe must not run on iOS at all.

const register = vi.fn().mockResolvedValue(undefined);
const pushCalls: string[] = [];

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    requestPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    register,
    addListener: vi.fn((name: string) => {
      pushCalls.push(`add:${name}`);
      return Promise.resolve({ remove: vi.fn() });
    }),
    removeAllListeners: vi.fn(() => {
      pushCalls.push('removeAll');
      return Promise.resolve(undefined);
    }),
  },
}));

vi.mock('@/shared/lib/platform', () => ({
  isNative: true,
  isIOS: true,
}));

const isFcmAvailable = vi.fn().mockRejectedValue({ code: 'UNIMPLEMENTED' });

vi.mock('./push-data-plugin', () => ({
  PushData: {
    cacheRoomNames: vi.fn().mockResolvedValue(undefined),
    cacheSenderNames: vi.fn().mockResolvedValue(undefined),
    getPendingIntent: vi.fn().mockResolvedValue({}),
    isFcmAvailable,
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  },
}));

const voipAddListener = vi.fn().mockResolvedValue({ remove: vi.fn() });
const voipGetToken = vi.fn().mockResolvedValue({ token: null });

vi.mock('./ios-voip-push', () => ({
  IOSVoIPPush: {
    addListener: voipAddListener,
    getToken: voipGetToken,
  },
}));

vi.mock('@/shared/lib/i18n', () => ({
  tRaw: (k: string) => k,
}));

describe('PushService on iOS', () => {
  beforeEach(() => {
    register.mockClear();
    isFcmAvailable.mockClear();
    voipAddListener.mockClear();
  });

  it('registers for APNs and wires the VoIP token without probing FCM availability', async () => {
    const { pushService } = await import('./push-service');
    await pushService.init({ setPusher: vi.fn(), getPushers: vi.fn() });
    expect(isFcmAvailable).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledTimes(1);
    const events = voipAddListener.mock.calls.map(([name]) => name);
    expect(events).toContain('voipTokenReceived');
    expect(events).toContain('voipTokenInvalidated');
    expect(voipGetToken).toHaveBeenCalled();
  });

  // Regression: the tap listener was added before removeAllListeners and
  // removed with it, so tapping a notification while the app ran did nothing.
  it('keeps the notification tap listener after clearing listeners', async () => {
    pushCalls.length = 0;
    const { pushService } = await import('./push-service');
    await pushService.init({ setPusher: vi.fn(), getPushers: vi.fn() });
    const lastClear = pushCalls.lastIndexOf('removeAll');
    const tap = pushCalls.lastIndexOf('add:pushNotificationActionPerformed');
    expect(tap).toBeGreaterThan(lastClear);
  });

  // Regression: every init() (one per login) added another pair of VoIP
  // listeners and each closure kept the client it was created with, so a
  // rotated token re-registered the pusher for every past account.
  it('replaces the VoIP listeners on re-init and registers the token for the current client only', async () => {
    const removes: ReturnType<typeof vi.fn>[] = [];
    const handlers: Array<(d: { token: string }) => Promise<void>> = [];
    voipAddListener.mockImplementation((name: string, cb: (d: { token: string }) => Promise<void>) => {
      const remove = vi.fn().mockResolvedValue(undefined);
      removes.push(remove);
      if (name === 'voipTokenReceived') handlers.push(cb);
      return Promise.resolve({ remove });
    });
    try {
    const { pushService } = await import('./push-service');
    const first = { setPusher: vi.fn().mockResolvedValue({}), getPushers: vi.fn().mockResolvedValue({ pushers: [] }) };
    const second = { setPusher: vi.fn().mockResolvedValue({}), getPushers: vi.fn().mockResolvedValue({ pushers: [] }) };
    await pushService.init(first);
    await pushService.init(second);

    // Three listeners per init: token received, token invalidated, push received.
    expect(removes.slice(0, 3).every((r) => r.mock.calls.length === 1)).toBe(true);
    expect(removes.slice(3).every((r) => r.mock.calls.length === 0)).toBe(true);

    first.setPusher.mockClear();
    await handlers[handlers.length - 1]({ token: 'rotated' });
    expect(first.setPusher).not.toHaveBeenCalled();
    expect(second.setPusher).toHaveBeenCalledWith(expect.objectContaining({ pushkey: 'rotated' }));

    // A stale closure that fires anyway still uses the current client.
    second.setPusher.mockClear();
    await handlers[0]({ token: 'late' });
    expect(first.setPusher).not.toHaveBeenCalled();
    } finally {
      voipAddListener.mockImplementation(() => Promise.resolve({ remove: vi.fn() }));
    }
  });

  // Each APNs server has its own Sygnal pushkin: a token from an Xcode build
  // registered as fortaios.voip would be sent to the production server and fail.
  it('registers the VoIP pusher under the app_id of the APNs server of its token', async () => {
    voipGetToken.mockResolvedValueOnce({ token: 'voip-hex', environment: 'sandbox' });
    const client = { setPusher: vi.fn().mockResolvedValue({}), getPushers: vi.fn().mockResolvedValue({ pushers: [] }) };
    const { pushService } = await import('./push-service');
    await pushService.init(client);

    expect(client.setPusher).toHaveBeenCalledWith(
      expect.objectContaining({ pushkey: 'voip-hex', app_id: 'fortaios.voip.sandbox' }),
    );

    const onToken = voipAddListener.mock.calls.find(([name]) => name === 'voipTokenReceived')?.[1] as
      (data: { token: string }) => Promise<void>;
    await onToken({ token: 'voip-hex-2' });
    // Older native builds send no environment: production.
    expect(client.setPusher).toHaveBeenCalledWith(
      expect.objectContaining({ pushkey: 'voip-hex-2', app_id: 'fortaios.voip' }),
    );
  });

  // iPhone XR 2026-10-14: the push woke a backgrounded Forta whose /sync sat
  // in backoff, so the invite came only once the app was opened, and an
  // Accept on CallKit never connected.
  it('wakes the Matrix sync when a VoIP push arrives', async () => {
    const client = { setPusher: vi.fn().mockResolvedValue({}), getPushers: vi.fn().mockResolvedValue({ pushers: [] }), retryImmediately: vi.fn() };
    const { pushService } = await import('./push-service');
    await pushService.init(client);
    const onPush = voipAddListener.mock.calls.filter(([name]) => name === 'voipPushReceived').pop()?.[1] as (() => void) | undefined;
    expect(onPush).toBeDefined();
    onPush?.();
    expect(client.retryImmediately).toHaveBeenCalledTimes(1);
  });

  // Review 2026-10-14: the client init() captured is stopped after an
  // in-place failover to another host; the kick must reach the live one.
  it('wakes the live client through the sync kicker when one is set', async () => {
    const stale = { setPusher: vi.fn().mockResolvedValue({}), getPushers: vi.fn().mockResolvedValue({ pushers: [] }), retryImmediately: vi.fn() };
    const kicker = vi.fn();
    const { pushService } = await import('./push-service');
    pushService.setSyncKicker(kicker);
    await pushService.init(stale);
    const onPush = voipAddListener.mock.calls.filter(([name]) => name === 'voipPushReceived').pop()?.[1] as (() => void) | undefined;
    onPush?.();
    expect(kicker).toHaveBeenCalledTimes(1);
    expect(stale.retryImmediately).not.toHaveBeenCalled();
    pushService.setSyncKicker(null);
  });
});
