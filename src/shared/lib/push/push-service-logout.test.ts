/**
 * Regression: logout left this device's pusher on the homeserver and kept the
 * FCM token, so the Pixel went on ringing for the account it had signed out
 * of (TEST3, 2026-09-24). `unregisterForLogout` tells native to drop pushes
 * (iOS: report and end a VoIP call at once),
 * deletes the pushers and, on Android, the FCM token — without ever holding
 * logout up for longer than LOGOUT_UNREGISTER_TIMEOUT_MS.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const platform = vi.hoisted(() => ({ ios: false }));

const PushNotifications = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  addListener: vi.fn(),
  removeAllListeners: vi.fn(),
}));

const PushData = vi.hoisted(() => ({
  isFcmAvailable: vi.fn(),
  getPendingIntent: vi.fn(),
  addListener: vi.fn(),
  markSessionActive: vi.fn(),
  markLoggedOut: vi.fn(),
}));

vi.mock('@capacitor/push-notifications', () => ({ PushNotifications }));
vi.mock('@/shared/lib/platform', () => ({
  isNative: true,
  get isIOS() {
    return platform.ios;
  },
}));
vi.mock('./push-data-plugin', () => ({ PushData }));
vi.mock('./ios-voip-push', () => ({
  IOSVoIPPush: {
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
    getToken: vi.fn().mockResolvedValue({ token: null }),
  },
}));
vi.mock('@/shared/lib/i18n', () => ({ tRaw: (k: string) => k }));

interface ServiceInternals {
  matrixClient: unknown;
  fcmToken: string | null;
  voipToken: string | null;
}

async function loadService() {
  const mod = await import('./push-service');
  return { mod, svc: mod.pushService, internals: mod.pushService as unknown as ServiceInternals };
}

function signedIn(internals: ServiceInternals, tokens: { fcm?: string; voip?: string } = { fcm: 'fcm-token' }) {
  const client = { setPusher: vi.fn().mockResolvedValue({}) };
  internals.matrixClient = client;
  internals.fcmToken = tokens.fcm ?? null;
  internals.voipToken = tokens.voip ?? null;
  return client;
}

describe('pushService.unregisterForLogout', () => {
  beforeEach(() => {
    platform.ios = false;
    vi.clearAllMocks();
    for (const f of [...Object.values(PushNotifications), ...Object.values(PushData)]) {
      f.mockResolvedValue(undefined);
    }
    PushNotifications.checkPermissions.mockResolvedValue({ receive: 'granted' });
    PushNotifications.addListener.mockResolvedValue({ remove: vi.fn() });
    PushData.isFcmAvailable.mockResolvedValue({ available: true });
    PushData.getPendingIntent.mockResolvedValue({});
    PushData.addListener.mockResolvedValue({ remove: vi.fn() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks the Android session active when push starts', async () => {
    const { svc } = await loadService();
    await svc.init({ setPusher: vi.fn() });
    expect(PushData.markSessionActive).toHaveBeenCalledOnce();
  });

  it('deletes the Android pusher and the FCM token, after telling native to drop pushes', async () => {
    const { svc, internals } = await loadService();
    const client = signedIn(internals);

    await svc.unregisterForLogout();

    expect(client.setPusher).toHaveBeenCalledWith(
      expect.objectContaining({ pushkey: 'fcm-token', app_id: 'fortaandroid', kind: null }),
    );
    expect(PushNotifications.unregister).toHaveBeenCalledOnce();
    expect(PushNotifications.removeAllListeners).toHaveBeenCalled();
    expect(PushData.markLoggedOut.mock.invocationCallOrder[0]).toBeLessThan(
      client.setPusher.mock.invocationCallOrder[0],
    );
  });

  it('deletes both iOS pushers and leaves the APNs registration alone', async () => {
    platform.ios = true;
    const { svc, internals } = await loadService();
    const client = signedIn(internals, { fcm: 'apns-token', voip: 'voip-token' });

    await svc.unregisterForLogout();

    expect(client.setPusher).toHaveBeenCalledWith(
      expect.objectContaining({ pushkey: 'apns-token', app_id: 'fortaios', kind: null }),
    );
    expect(client.setPusher).toHaveBeenCalledWith(
      expect.objectContaining({ pushkey: 'voip-token', app_id: 'fortaios.voip', kind: null }),
    );
    expect(PushNotifications.unregister).not.toHaveBeenCalled();
    // The VoIP pusher may survive an offline logout; native ends its calls.
    expect(PushData.markLoggedOut).toHaveBeenCalledOnce();
  });

  it('marks the iOS session active when push starts', async () => {
    platform.ios = true;
    const { svc } = await loadService();
    await svc.init({ setPusher: vi.fn() });
    expect(PushData.markSessionActive).toHaveBeenCalledOnce();
  });

  it('does not hold logout up when the homeserver never answers', async () => {
    vi.useFakeTimers();
    const { mod, svc, internals } = await loadService();
    const client = signedIn(internals);
    client.setPusher.mockReturnValue(new Promise(() => {}));

    let done = false;
    const run = svc.unregisterForLogout().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(mod.LOGOUT_UNREGISTER_TIMEOUT_MS);
    await run;

    expect(done).toBe(true);
    expect(PushData.markLoggedOut).toHaveBeenCalledOnce();
  });

  it('never throws, whatever fails', async () => {
    const { svc, internals } = await loadService();
    const client = signedIn(internals);
    client.setPusher.mockRejectedValue(new Error('offline'));
    PushData.markLoggedOut.mockRejectedValue(new Error('no plugin'));
    PushNotifications.unregister.mockImplementation(() => { throw new Error('sync'); });

    await expect(svc.unregisterForLogout()).resolves.toBeUndefined();
  });

  it('forgets the tokens, so a second logout deletes nothing twice', async () => {
    const { svc, internals } = await loadService();
    const client = signedIn(internals);

    await svc.unregisterForLogout();
    await svc.unregisterForLogout();

    expect(client.setPusher).toHaveBeenCalledOnce();
  });

  describe('settleSignedOutLaunch', () => {
    it('drops pushes and deletes the FCM token an older build left registered', async () => {
      const { svc } = await loadService();

      svc.settleSignedOutLaunch();
      await vi.waitFor(() => expect(PushNotifications.unregister).toHaveBeenCalledOnce());

      expect(PushData.markLoggedOut).toHaveBeenCalledOnce();
    });

    it('on iOS only marks the session, leaving the APNs registration alone', async () => {
      platform.ios = true;
      const { svc } = await loadService();

      svc.settleSignedOutLaunch();
      await vi.waitFor(() => expect(PushData.markLoggedOut).toHaveBeenCalledOnce());

      expect(PushNotifications.unregister).not.toHaveBeenCalled();
    });

    it('lets a quick login register only after the old token is gone', async () => {
      const { svc } = await loadService();
      let finishDelete!: () => void;
      PushNotifications.unregister.mockReturnValue(new Promise<void>((r) => { finishDelete = r; }));

      svc.settleSignedOutLaunch();
      const init = svc.init({ setPusher: vi.fn() });
      await vi.waitFor(() => expect(PushNotifications.unregister).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      expect(PushNotifications.register).not.toHaveBeenCalled();

      finishDelete();
      await init;
      expect(PushNotifications.register).toHaveBeenCalledOnce();
    });
  });
});
