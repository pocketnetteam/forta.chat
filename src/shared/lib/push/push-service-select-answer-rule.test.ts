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
 * The app installs the account's `m.call.select_answer` push rule next to the hangup one,
 * so a phone ringing behind a frozen page stops once another device answers
 * (forta-bugs#809, the owner's variant A, 2026-09-18).
 */
const RULES_WITHOUT = { global: { underride: [{ rule_id: 'com.forta.call.hangup', enabled: true }] } };
const RULES_WITH = {
  global: {
    underride: [
      { rule_id: 'com.forta.call.hangup', enabled: true },
      { rule_id: 'com.forta.call.select_answer', enabled: true },
    ],
  },
};

type Client = {
  getPushRules: ReturnType<typeof vi.fn>;
  addPushRule: ReturnType<typeof vi.fn>;
  getUserId?: () => string;
};

function makeClient(rules: unknown[]): Client {
  const getPushRules = vi.fn();
  for (const r of rules) getPushRules.mockResolvedValueOnce(r);
  getPushRules.mockResolvedValue(rules[rules.length - 1]);
  return { getPushRules, addPushRule: vi.fn().mockResolvedValue({}) };
}

async function ensure(client: Client): Promise<void> {
  const mod = await import('./push-service');
  const svc = mod.pushService as unknown as { ensureCallSelectAnswerPushRule: (c: Client) => Promise<void> };
  return svc.ensureCallSelectAnswerPushRule(client);
}

describe('PushService.ensureCallSelectAnswerPushRule', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('adds the rule when the account has none, then reloads the rules the badge reads', async () => {
    const client = makeClient([RULES_WITHOUT, RULES_WITH]);
    await ensure(client);
    expect(client.addPushRule).toHaveBeenCalledTimes(1);
    expect(client.addPushRule).toHaveBeenCalledWith('global', 'underride', 'com.forta.call.select_answer', {
      conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.call.select_answer' }],
      actions: ['notify'],
    });
    expect(client.getPushRules).toHaveBeenCalledTimes(2);
  });

  it('leaves a rule that is already there alone, even one the user disabled', async () => {
    const disabled = { global: { underride: [{ rule_id: 'com.forta.call.select_answer', enabled: false }] } };
    for (const rules of [RULES_WITH, disabled]) {
      const client = makeClient([rules]);
      await ensure(client);
      expect(client.addPushRule).not.toHaveBeenCalled();
    }
  });

  it('never throws: a failed write only logs', async () => {
    const writeFails = makeClient([RULES_WITHOUT]);
    writeFails.addPushRule.mockRejectedValue(new Error('forbidden'));
    await expect(ensure(writeFails)).resolves.toBeUndefined();
  });

  it('dates the rule on this device right away', async () => {
    const key = 'forta.callSelectAnswerRuleSince:@me:s';
    localStorage.removeItem(key);
    const client = { ...makeClient([RULES_WITHOUT, RULES_WITH]), getUserId: () => '@me:s' };
    const before = Date.now();
    await ensure(client);
    expect(Number(localStorage.getItem(key))).toBeGreaterThanOrEqual(before);
  });

  it('is not installed from iOS, whose push handler does not act on it', async () => {
    vi.doMock('@/shared/lib/platform', () => ({ isNative: true, isIOS: true }));
    const client = makeClient([RULES_WITHOUT]);
    await ensure(client);
    expect(client.getPushRules).not.toHaveBeenCalled();
    expect(client.addPushRule).not.toHaveBeenCalled();
    vi.doUnmock('@/shared/lib/platform');
  });
});
