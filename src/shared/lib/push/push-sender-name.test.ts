import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Audit S6-01: push titles used the Matrix member name, or even the raw Matrix
 * ID, bypassing the contact's local alias that the chat itself shows.
 */

vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: {} }));
vi.mock('./push-data-plugin', () => ({ PushData: {} }));
vi.mock('./ios-voip-push', () => ({ IOSVoIPPush: {} }));
vi.mock('@/shared/lib/platform', () => ({ isNative: true, isIOS: false }));
vi.mock('@/shared/lib/i18n', () => ({ tRaw: (k: string) => k }));

const { pushService } = await import('./push-service');

interface Internals {
  matrixClient: unknown;
  findDecryptedEvent(roomId: string, eventId: string | undefined): { senderName: string; body: string } | null;
}
const internals = pushService as unknown as Internals;

const withEvent = (sender: string, memberName: string | undefined) => {
  internals.matrixClient = {
    getRoom: () => ({
      getLiveTimeline: () => ({
        getEvents: () => [
          {
            getId: () => '$e',
            getType: () => 'm.room.message',
            isDecryptionFailure: () => false,
            getContent: () => ({ msgtype: 'm.text', body: 'hi' }),
            getSender: () => sender,
            sender: memberName ? { name: memberName } : undefined,
          },
        ],
      }),
    }),
  };
};

describe('push sender names', () => {
  it('shows the contact alias from the chat, not the Matrix name', () => {
    withEvent('@abc:server', 'Matrix Name');
    pushService.setSenderNameResolver((id) => (id === '@abc:server' ? 'My Alias' : null));
    expect(internals.findDecryptedEvent('!r:s', '$e')?.senderName).toBe('My Alias');
  });

  it('falls back to the Matrix name when the chat has none', () => {
    withEvent('@abc:server', 'Matrix Name');
    pushService.setSenderNameResolver(() => null);
    expect(internals.findDecryptedEvent('!r:s', '$e')?.senderName).toBe('Matrix Name');
  });

  it('survives a resolver that throws', () => {
    withEvent('@abc:server', 'Matrix Name');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    pushService.setSenderNameResolver(() => {
      throw new Error('store gone');
    });
    expect(internals.findDecryptedEvent('!r:s', '$e')?.senderName).toBe('Matrix Name');
    pushService.setSenderNameResolver(null);
  });

  it('is wired to the chat display names, also for the cache native reads', () => {
    const stores = readFileSync(resolve(__dirname, '../../../entities/auth/model/stores.ts'), 'utf-8');
    expect(stores).toContain('pushService.setSenderNameResolver(pushSenderName);');
    // The known-name variant, not getDisplayName: its truncated-address fallback
    // would beat the Matrix member name (batch-6 follow-up review).
    expect(stores).toContain('return address ? chatStore.getKnownDisplayName(address) : null;');
    expect(stores).toContain('const name = pushSenderName(userId) || member.name;');
  });
});
