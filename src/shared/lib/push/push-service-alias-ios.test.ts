import { describe, it, expect, vi } from 'vitest';

/**
 * Review 2026-10-10: the iOS PushData plugin has no cacheSenderAliases (the
 * aliases are an Android fix, audit S6-01), so every sync logged a caught
 * UNIMPLEMENTED warning there. iOS skips the call.
 */
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }), removeAllListeners: vi.fn() },
}));
vi.mock('@/shared/lib/platform', () => ({ isNative: true, isIOS: true }));
vi.mock('./push-data-plugin', () => ({
  PushData: {
    cacheSenderNames: vi.fn().mockResolvedValue(undefined),
    cacheSenderAliases: vi.fn().mockResolvedValue(undefined),
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  },
}));
vi.mock('@/shared/lib/i18n', () => ({ tRaw: (k: string) => k }));

describe('PushService — contact aliases on iOS', () => {
  it('does not call the Android-only plugin method', async () => {
    const { pushService } = await import('./push-service');
    const { PushData } = await import('./push-data-plugin');
    pushService.setSenderAliasesGetter(() => ({ '@50426f62:server': 'Bobby' }));

    await pushService.syncSenderAliasesToNative();

    expect(PushData.cacheSenderAliases).not.toHaveBeenCalled();
  });
});
