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

    expect(removes.slice(0, 2).every((r) => r.mock.calls.length === 1)).toBe(true);
    expect(removes.slice(2).every((r) => r.mock.calls.length === 0)).toBe(true);

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
});
