// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { listeners } = vi.hoisted(() => ({
  listeners: {} as Record<string, (arg: unknown) => unknown>,
}));

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    requestPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    register: vi.fn().mockResolvedValue(undefined),
    addListener: vi.fn((event: string, cb: (arg: unknown) => unknown) => {
      listeners[event] = cb;
      return Promise.resolve({ remove: vi.fn() });
    }),
    removeAllListeners: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/shared/lib/platform', () => ({
  isNative: true,
  isIOS: false,
}));

vi.mock('./push-data-plugin', () => ({
  PushData: {
    isFcmAvailable: vi.fn().mockResolvedValue({ available: true }),
    cacheRoomNames: vi.fn().mockResolvedValue(undefined),
    cacheSenderNames: vi.fn().mockResolvedValue(undefined),
    getPendingIntent: vi.fn().mockResolvedValue({}),
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  },
}));

vi.mock('@/shared/lib/i18n', () => ({
  tRaw: (k: string) => k,
}));

/**
 * The app installs the account's `m.call.hangup` push rule once its pusher is set,
 * so a caller's hangup reaches a phone whose app is dead. The owner chose this on
 * 2026-09-15 together with taking those hangups back out of the unread badge.
 */
const RULES_WITHOUT = { global: { underride: [{ rule_id: '.m.rule.call', enabled: true }] } };
const RULES_WITH = {
  global: { underride: [{ rule_id: 'com.forta.call.hangup', enabled: true }, { rule_id: '.m.rule.call', enabled: true }] },
};

type Client = {
  setPusher: ReturnType<typeof vi.fn>;
  getPushers: ReturnType<typeof vi.fn>;
  getPushRules: ReturnType<typeof vi.fn>;
  addPushRule: ReturnType<typeof vi.fn>;
};

function makeClient(rules: unknown[]): Client {
  const getPushRules = vi.fn();
  for (const r of rules) getPushRules.mockResolvedValueOnce(r);
  getPushRules.mockResolvedValue(rules[rules.length - 1]);
  return {
    setPusher: vi.fn().mockResolvedValue(undefined),
    getPushers: vi.fn().mockResolvedValue({ pushers: [] }),
    getPushRules,
    addPushRule: vi.fn().mockResolvedValue({}),
  };
}

async function ensure(client: Client): Promise<void> {
  const mod = await import('./push-service');
  const svc = mod.pushService as unknown as { ensureCallHangupPushRule: (c: Client) => Promise<void> };
  return svc.ensureCallHangupPushRule(client);
}

describe('PushService.ensureCallHangupPushRule', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('adds the rule when the account has none, then reloads the rules the badge reads', async () => {
    const client = makeClient([RULES_WITHOUT, RULES_WITH]);
    await ensure(client);
    expect(client.addPushRule).toHaveBeenCalledTimes(1);
    expect(client.addPushRule).toHaveBeenCalledWith('global', 'underride', 'com.forta.call.hangup', {
      conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.call.hangup' }],
      actions: ['notify'],
    });
    // addPushRule does not refresh client.pushRules; the unread badge reads that cache.
    expect(client.getPushRules).toHaveBeenCalledTimes(2);
    expect(client.addPushRule.mock.invocationCallOrder[0]).toBeLessThan(client.getPushRules.mock.invocationCallOrder[1]);
  });

  it('leaves a rule that is already there alone, even one the user disabled', async () => {
    const disabled = { global: { underride: [{ rule_id: 'com.forta.call.hangup', enabled: false }] } };
    for (const rules of [RULES_WITH, disabled]) {
      const client = makeClient([rules]);
      await ensure(client);
      expect(client.addPushRule).not.toHaveBeenCalled();
    }
  });

  it('never throws: a failed read or write only logs', async () => {
    const readFails = makeClient([]);
    readFails.getPushRules.mockRejectedValue(new Error('offline'));
    await expect(ensure(readFails)).resolves.toBeUndefined();
    expect(readFails.addPushRule).not.toHaveBeenCalled();

    const writeFails = makeClient([RULES_WITHOUT]);
    writeFails.addPushRule.mockRejectedValue(new Error('forbidden'));
    await expect(ensure(writeFails)).resolves.toBeUndefined();
  });

  it('dates the rule on this device right away, before the first hangup it counts arrives', async () => {
    // A missed call and its hangup can land in one sync while JS was dead; dated only
    // then, the hangup would look older than the rule and stay in the badge.
    const key = 'forta.callHangupRuleSince:@me:s';
    localStorage.removeItem(key);
    const client = { ...makeClient([RULES_WITHOUT, RULES_WITH]), getUserId: () => '@me:s' };
    const before = Date.now();
    await ensure(client);
    expect(Number(localStorage.getItem(key))).toBeGreaterThanOrEqual(before);
  });
});

describe('PushService registration', () => {
  it('ensures the hangup rule after the pusher is set', async () => {
    const mod = await import('./push-service');
    const client = makeClient([RULES_WITHOUT, RULES_WITH]);
    await mod.pushService.init(client);
    await listeners.registration({ value: 'token-abc' });
    expect(client.setPusher).toHaveBeenCalledTimes(1);
    // The select_answer rule follows it (push-service-select-answer-rule.test.ts).
    expect(client.addPushRule.mock.calls.map((c) => c[2])).toEqual(['com.forta.call.hangup', 'com.forta.call.select_answer']);
    expect(client.setPusher.mock.invocationCallOrder[0]).toBeLessThan(client.addPushRule.mock.invocationCallOrder[0]);
  });
});
