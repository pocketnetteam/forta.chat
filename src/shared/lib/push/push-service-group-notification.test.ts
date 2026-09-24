import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Users could not tell a push from a group chat apart from a direct one: the
 * JS replacement always wrote `title = sender name`, so the group the message
 * belonged to never appeared. Group rooms must now be titled with the room
 * name, with the author folded into the body.
 *
 * Also covers the JS → native mirror of `rooms.isGroup`: the FCM payload has
 * no group marker, so the cold-start (Kotlin) renderer depends on this cache.
 */

const replaceNotificationContent = vi.fn().mockResolvedValue(undefined);
const cacheGroupRooms = vi.fn().mockResolvedValue(undefined);
const cacheRoomNames = vi.fn().mockResolvedValue(undefined);

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
    cacheRoomNames,
    cacheGroupRooms,
    cacheSenderNames: vi.fn().mockResolvedValue(undefined),
    cancelNotification: vi.fn().mockResolvedValue(undefined),
    cancelAllMessageNotifications: vi.fn().mockResolvedValue(undefined),
    replaceNotificationContent,
    getPendingIntent: vi.fn().mockResolvedValue({}),
    isFcmAvailable: vi.fn().mockResolvedValue({ available: true }),
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  },
}));

vi.mock('@/shared/lib/i18n', () => ({
  tRaw: (k: string) => k,
}));

type ReplaceNotification = (
  roomId: string,
  eventId: string | undefined,
  result: { senderName: string; body: string },
) => Promise<void>;

interface ServiceInternals {
  replaceNotification: ReplaceNotification;
  setRoomInfoGetter: (getter: (roomId: string) => { roomName: string; isGroup?: boolean } | null) => void;
  setAllGroupRoomsGetter: (getter: () => Record<string, boolean>) => void;
  syncRoomNamesToNative: () => Promise<void>;
  setAllRoomNamesGetter: (getter: () => Record<string, string>) => void;
}

async function getService(): Promise<ServiceInternals> {
  const mod = await import('./push-service');
  return mod.pushService as unknown as ServiceInternals;
}

describe('PushService.replaceNotification — group chat marker', () => {
  beforeEach(() => {
    replaceNotificationContent.mockClear();
  });

  it('titles a group push with the room name and prefixes the body with the sender', async () => {
    const svc = await getService();
    svc.setRoomInfoGetter(() => ({ roomName: 'Forta Team', isGroup: true }));

    await svc.replaceNotification('!room:server', '$evt', {
      senderName: 'Alice',
      body: 'see you at 10',
    });

    expect(replaceNotificationContent).toHaveBeenCalledWith({
      roomId: '!room:server',
      eventId: '$evt',
      title: 'Forta Team',
      body: 'Alice: see you at 10',
    });
  });

  it('keeps the sender-titled layout for direct chats', async () => {
    const svc = await getService();
    svc.setRoomInfoGetter(() => ({ roomName: 'Alice', isGroup: false }));

    await svc.replaceNotification('!dm:server', '$evt', {
      senderName: 'Alice',
      body: 'see you at 10',
    });

    expect(replaceNotificationContent).toHaveBeenCalledWith({
      roomId: '!dm:server',
      eventId: '$evt',
      title: 'Alice',
      body: 'see you at 10',
    });
  });

  it('falls back to the sender when the room is unknown', async () => {
    const svc = await getService();
    svc.setRoomInfoGetter(() => null);

    await svc.replaceNotification('!gone:server', undefined, {
      senderName: 'Alice',
      body: 'see you at 10',
    });

    expect(replaceNotificationContent).toHaveBeenCalledWith({
      roomId: '!gone:server',
      eventId: undefined,
      title: 'Alice',
      body: 'see you at 10',
    });
  });
});

describe('PushService.syncRoomNamesToNative — group flags', () => {
  beforeEach(() => {
    cacheGroupRooms.mockClear();
    cacheRoomNames.mockClear();
  });

  it('mirrors roomId → isGroup to native alongside the room names', async () => {
    const svc = await getService();
    svc.setAllRoomNamesGetter(() => ({ '!g:server': 'Forta Team' }));
    svc.setAllGroupRoomsGetter(() => ({ '!g:server': true, '!dm:server': false }));

    await svc.syncRoomNamesToNative();

    expect(cacheRoomNames).toHaveBeenCalledWith({ rooms: { '!g:server': 'Forta Team' } });
    expect(cacheGroupRooms).toHaveBeenCalledWith({
      rooms: { '!g:server': true, '!dm:server': false },
    });
  });

  it('survives a native build without cacheGroupRooms', async () => {
    const svc = await getService();
    svc.setAllRoomNamesGetter(() => ({ '!g:server': 'Forta Team' }));
    svc.setAllGroupRoomsGetter(() => ({ '!g:server': true }));
    cacheGroupRooms.mockRejectedValueOnce(new Error('not implemented'));

    await expect(svc.syncRoomNamesToNative()).resolves.toBeUndefined();
    expect(cacheRoomNames).toHaveBeenCalled();
  });
});
