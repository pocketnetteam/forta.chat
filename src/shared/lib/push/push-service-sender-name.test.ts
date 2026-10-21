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
    cacheSenderAliases: vi.fn().mockResolvedValue(undefined),
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

// Device check 2026-10-10 (audit S6-01): with the page asleep native draws the
// title, and it never had the aliases.
describe('PushService — contact aliases for native titles', () => {
  it('hands the whole alias set to native with the sender names', async () => {
    const { pushService } = await serviceWithoutMember();
    const { PushData } = await import('./push-data-plugin');
    pushService.setAllSenderNamesGetter(() => ({ '@50426f62:server': 'Bob' }));
    pushService.setSenderAliasesGetter(() => ({ '@50426f62:server': 'Bobby' }));

    await pushService.syncSenderNamesToNative();

    expect(PushData.cacheSenderAliases).toHaveBeenCalledWith({ aliases: { '@50426f62:server': 'Bobby' } });
  });

  it('sends an empty set too, so a removed alias leaves native', async () => {
    const { pushService } = await serviceWithoutMember();
    const { PushData } = await import('./push-data-plugin');
    pushService.setSenderAliasesGetter(() => ({}));

    await pushService.syncSenderAliasesToNative();

    expect(PushData.cacheSenderAliases).toHaveBeenLastCalledWith({ aliases: {} });
  });
});

// Device check 2026-10-10: a short group message is AES-CBC ciphertext in hex
// (msgtype m.encrypted), 32 characters for up to 15 bytes of text. The
// base64-length check let it through, and the notification showed the hex.
describe('PushService — targeted fetch of a group message', () => {
  it('does not take Bastyon group ciphertext for the message text', async () => {
    const { fetch } = await serviceWithoutMember();
    fetchRoomEvent.mockResolvedValueOnce({
      type: 'm.room.message',
      sender: '@50426f62:server',
      content: { msgtype: 'm.encrypted', body: 'a3410f4658155fb2bbaddf043a4f1b47', block: 1, hash: 'h' },
    });

    await expect(fetch('!r:s', '$e')).resolves.toBeNull();
  });
});

describe('PushService — timeline lookup of a group message', () => {
  it('skips an SDK event whose content is still Bastyon ciphertext', async () => {
    const mod = await import('./push-service');
    const svc = mod.pushService as unknown as {
      matrixClient: unknown;
      findDecryptedEvent: (roomId: string, eventId: string) => unknown;
    };
    const event = {
      getId: () => '$e',
      getType: () => 'm.room.message',
      isDecryptionFailure: () => false,
      getContent: () => ({ msgtype: 'm.encrypted', body: 'a3410f4658155fb2bbaddf043a4f1b47' }),
      getSender: () => '@50426f62:server',
    };
    svc.matrixClient = { getRoom: () => ({ getLiveTimeline: () => ({ getEvents: () => [event] }) }) };

    expect(svc.findDecryptedEvent.call(mod.pushService, '!r:s', '$e')).toBeNull();
    expect(mod.isBastyonCiphertext({ msgtype: 'm.text', body: 'grp-182504-001' })).toBe(false);
  });
});
