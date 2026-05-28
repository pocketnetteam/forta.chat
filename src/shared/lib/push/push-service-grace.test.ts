import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * WEE-11 / forta-bugs#686 regression:
 *
 * `tryTargetedFetch` must wait `graceMs` BEFORE asking the homeserver for
 * the event. Without the grace, cold-start FCM pushes routinely arrive
 * ahead of homeserver event indexing → fetchRoomEvent 404s → we fall
 * through to the 15s timeline-wait path and the user keeps staring at the
 * raw-Matrix-ID title.
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

vi.mock('./push-data-plugin', () => ({
  PushData: {
    cacheRoomNames: vi.fn().mockResolvedValue(undefined),
    cacheSenderNames: vi.fn().mockResolvedValue(undefined),
    cancelNotification: vi.fn().mockResolvedValue(undefined),
    cancelAllMessageNotifications: vi.fn().mockResolvedValue(undefined),
    replaceNotificationContent: vi.fn().mockResolvedValue(undefined),
    getPendingIntent: vi.fn().mockResolvedValue({}),
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  },
}));

vi.mock('@/shared/lib/i18n', () => ({
  tRaw: (k: string) => k,
}));

vi.mock('@/entities/matrix/model/matrix-client', () => ({
  getMatrixClientService: () => ({
    fetchRoomEvent,
  }),
}));

interface TryTargetedFetch {
  (
    roomId: string,
    eventId: string,
    opts?: { graceMs?: number },
  ): Promise<{ senderName: string; body: string } | null>;
}

async function getTargetedFetch(): Promise<TryTargetedFetch> {
  const mod = await import('./push-service');
  const svc = mod.pushService as unknown as {
    tryTargetedFetch: TryTargetedFetch;
    matrixClient: unknown;
  };
  // tryTargetedFetch reads `this.matrixClient` only to resolve a display
  // name from room state; for the test we hand it a stub that returns
  // a basic member so the function never short-circuits via null-room.
  svc.matrixClient = {
    getRoom: () => ({
      getMember: () => ({ name: 'Alice' }),
    }),
  };
  return svc.tryTargetedFetch.bind(mod.pushService);
}

describe('PushService.tryTargetedFetch grace delay', () => {
  beforeEach(() => {
    fetchRoomEvent.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits the configured graceMs before issuing the fetch', async () => {
    const tryTargetedFetch = await getTargetedFetch();
    fetchRoomEvent.mockResolvedValue({
      type: 'm.room.message',
      sender: '@alice:matrix.bastyon.com',
      content: { msgtype: 'm.text', body: 'hello there' },
    });

    const promise = tryTargetedFetch('!room:server', '$event-1', { graceMs: 500 });

    // Before the grace elapses fetchRoomEvent must NOT have been called.
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchRoomEvent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(fetchRoomEvent).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ senderName: 'Alice', body: 'hello there' });
  });

  it('skips the wait when graceMs is omitted (backwards compatibility)', async () => {
    const tryTargetedFetch = await getTargetedFetch();
    fetchRoomEvent.mockResolvedValue({
      type: 'm.room.message',
      sender: '@alice:matrix.bastyon.com',
      content: { msgtype: 'm.text', body: 'instant' },
    });

    const promise = tryTargetedFetch('!room:server', '$event-2');
    // No timer advance — the call should resolve as fast as microtasks allow.
    const result = await promise;

    expect(fetchRoomEvent).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ senderName: 'Alice', body: 'instant' });
  });
});
