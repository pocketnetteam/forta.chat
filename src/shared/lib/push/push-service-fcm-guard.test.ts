import { describe, it, expect, vi, beforeEach } from 'vitest';

const register = vi.fn().mockResolvedValue(undefined);

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    requestPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    register,
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

const isFcmAvailable = vi.fn().mockResolvedValue({ available: false });

vi.mock('./push-data-plugin', () => ({
  PushData: {
    cacheRoomNames: vi.fn().mockResolvedValue(undefined),
    cacheSenderNames: vi.fn().mockResolvedValue(undefined),
    getPendingIntent: vi.fn().mockResolvedValue({}),
    isFcmAvailable,
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  },
}));

vi.mock('@/shared/lib/i18n', () => ({
  tRaw: (k: string) => k,
}));

describe('PushService FCM guard', () => {
  beforeEach(() => {
    register.mockClear();
    isFcmAvailable.mockResolvedValue({ available: false });
  });

  it('does not call PushNotifications.register when FCM is unavailable', async () => {
    const { pushService } = await import('./push-service');
    await pushService.init({ setPusher: vi.fn(), getPushers: vi.fn() });
    expect(isFcmAvailable).toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('registers for FCM when google-services was bundled', async () => {
    isFcmAvailable.mockResolvedValue({ available: true });
    const { pushService } = await import('./push-service');
    await pushService.init({ setPusher: vi.fn(), getPushers: vi.fn() });
    expect(register).toHaveBeenCalledTimes(1);
  });
});
