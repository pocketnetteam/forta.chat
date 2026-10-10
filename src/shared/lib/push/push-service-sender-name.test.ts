import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * With lazy-loaded members the room may have no member for a push's sender
 * (they did not post in the synced timeline). The notification then showed
 * the raw Matrix ID; it falls back to the cached profile name instead.
 */

const fetchRoomEvent = vi.fn();

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    requestPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    register: vi.fn().mockResolvedValue(undefined),
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
    removeAllListeners: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/shared/lib/platform', () => ({ isNative: true, isIOS: false }));

vi.mock('./push-data-plugin', () => ({
  PushData: {
    cacheRoomNames: vi.fn().mockResolvedValue(undefined),
    cacheSenderNames: vi.fn().mockResolvedValue(undefined),
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  },
}));

vi.mock('@/shared/lib/i18n', () => ({ tRaw: (k: string) => k }));

vi.mock('@/entities/matrix/model/matrix-client', () => ({
  getMatrixClientService: () => ({ fetchRoomEvent }),
}));

type TargetedFetch = (roomId: string, eventId: string) => Promise<{ senderName: string; body: string } | null>;

async function serviceWithoutMember() {
  const mod = await import('./push-service');
  const svc = mod.pushService as unknown as { tryTargetedFetch: TargetedFetch; matrixClient: unknown };
  svc.matrixClient = { getRoom: () => ({ getMember: () => null }) };
  return { pushService: mod.pushService, fetch: svc.tryTargetedFetch.bind(mod.pushService) };
}

describe('PushService — sender name without a room member', () => {
  beforeEach(() => {
    fetchRoomEvent.mockReset();
    fetchRoomEvent.mockResolvedValue({
      type: 'm.room.message',
      sender: '@50426f62:server',
      content: { msgtype: 'm.text', body: 'hi' },
    });
  });

  it('uses the profile name from the getter', async () => {
    const { pushService, fetch } = await serviceWithoutMember();
    pushService.setSenderNameGetter((id) => (id === '@50426f62:server' ? 'Bob' : null));

    await expect(fetch('!r:s', '$e')).resolves.toMatchObject({ senderName: 'Bob' });
  });

  it('uses the profile name for a member without a Matrix displayname (named by user id)', async () => {
    const { pushService, fetch } = await serviceWithoutMember();
    (pushService as unknown as { matrixClient: unknown }).matrixClient = {
      getRoom: () => ({ getMember: () => ({ name: '@50426f62:server' }) }),
    };
    pushService.setSenderNameGetter(() => 'Bob');

    await expect(fetch('!r:s', '$e')).resolves.toMatchObject({ senderName: 'Bob' });
  });

  it('falls back to the Matrix id when no profile is known', async () => {
    const { pushService, fetch } = await serviceWithoutMember();
    pushService.setSenderNameGetter(() => null);

    await expect(fetch('!r:s', '$e')).resolves.toMatchObject({ senderName: '@50426f62:server' });
  });
});
