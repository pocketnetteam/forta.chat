// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { PushPayload } from './push-data-plugin';

/**
 * A push for m.call.hangup, m.call.reject or m.call.select_answer is call
 * signalling, not a chat message. Native tears the ringer down and forwards
 * the push here, where it used to fall through to the message path: "New
 * message" in the room preview, +1 unread, and a decrypt-and-notify attempt.
 * These pushes reach the device once the account has a push rule for them.
 */

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
    cacheRoomNames: vi.fn().mockResolvedValue(undefined),
    cacheSenderNames: vi.fn().mockResolvedValue(undefined),
    cancelNotification: vi.fn().mockResolvedValue(undefined),
    cancelAllMessageNotifications: vi.fn().mockResolvedValue(undefined),
    replaceNotificationContent: vi.fn().mockResolvedValue(undefined),
    getPendingIntent: vi.fn().mockResolvedValue({}),
    isFcmAvailable: vi.fn().mockResolvedValue({ available: true }),
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  },
}));

vi.mock('@/shared/lib/i18n', () => ({
  tRaw: (k: string) => k,
}));

interface PushServiceInternals {
  handlePushFromNative: (data: PushPayload) => void;
  tryDecryptAndReplace: (data: PushPayload) => Promise<void>;
}

async function loadService() {
  const mod = await import('./push-service');
  const internals = mod.pushService as unknown as PushServiceInternals;
  const updatePreview = vi.fn().mockResolvedValue(true);
  const ring = vi.fn();
  mod.pushService.setOptimisticRoomUpdater(updatePreview);
  mod.pushService.setActiveRoomGetter(() => null);
  mod.pushService.setCallHandler(ring);
  const decrypt = vi.spyOn(internals, 'tryDecryptAndReplace').mockResolvedValue(undefined);
  return {
    handle: (data: PushPayload) => internals.handlePushFromNative.call(mod.pushService, data),
    updatePreview,
    ring,
    decrypt,
  };
}

describe('PushService.handlePushFromNative — call signalling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['m.call.hangup', 'm.call.reject', 'm.call.select_answer'])(
    '%s neither updates the room preview nor decrypts into a notification',
    async (msgType) => {
      const { handle, updatePreview, ring, decrypt } = await loadService();

      handle({ room_id: '!room:server', event_id: '$signal', msg_type: msgType, call_id: 'call-1' });

      expect(updatePreview).not.toHaveBeenCalled();
      expect(decrypt).not.toHaveBeenCalled();
      expect(ring).not.toHaveBeenCalled();
    },
  );

  it('a message push still updates the room preview and decrypts', async () => {
    const { handle, updatePreview, decrypt } = await loadService();

    handle({ room_id: '!room:server', event_id: '$message', msg_type: 'm.room.message', content_msgtype: 'm.text' });

    expect(updatePreview).toHaveBeenCalledTimes(1);
    expect(decrypt).toHaveBeenCalledTimes(1);
  });
});
