// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  CALL_HANGUP_PUSH_RULE_ID,
  CALL_HANGUP_PUSH_RULE_KIND,
  buildCallHangupPushRule,
  findCallHangupPushRule,
  callHangupRuleSince,
} from './call-hangup-push-rule';

/**
 * The account push rule that makes the homeserver push `m.call.hangup`.
 *
 * The default rules notify only `m.call.invite`, so with the app dead the phone never
 * heard that a caller hung up and the ringer ran out its 30 s. With this rule on the
 * test account the hangup push arrived and the ringer closed 7 ms later (`pr2`,
 * 2026-09-14).
 */
describe('call hangup push rule', () => {
  it('matches m.call.hangup and only notifies — no sound, no highlight', () => {
    expect(buildCallHangupPushRule()).toEqual({
      conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.call.hangup' }],
      actions: ['notify'],
    });
  });

  it('never matches m.call.select_answer, which has a rule dated on its own', () => {
    expect(JSON.stringify(buildCallHangupPushRule())).not.toContain('select_answer');
  });

  it('lives in underride under the app namespace, so a muted room still stays silent', () => {
    expect(CALL_HANGUP_PUSH_RULE_KIND).toBe('underride');
    expect(CALL_HANGUP_PUSH_RULE_ID).toBe('com.forta.call.hangup');
  });

  it('is found among the global underride rules, enabled or not', () => {
    const rule = { rule_id: CALL_HANGUP_PUSH_RULE_ID, enabled: false };
    expect(findCallHangupPushRule({ global: { underride: [{ rule_id: '.m.rule.call' }, rule] } })).toBe(rule);
    expect(findCallHangupPushRule({ global: { underride: [{ rule_id: '.m.rule.call' }] } })).toBeUndefined();
    expect(findCallHangupPushRule({ global: { override: [{ rule_id: CALL_HANGUP_PUSH_RULE_ID }] } })).toBeUndefined();
    expect(findCallHangupPushRule(undefined)).toBeUndefined();
  });
});

describe('callHangupRuleSince', () => {
  // The server counts a hangup as unread only if the rule existed when it was sent.
  // Taking back hangups sent before this device saw the rule could hide a missed call.
  const user = '@alice:example.org';
  const withRule = (enabled = true) => ({ global: { underride: [{ rule_id: CALL_HANGUP_PUSH_RULE_ID, enabled }] } });
  const withoutRule = { global: { underride: [{ rule_id: '.m.rule.call', enabled: true }] } };

  beforeEach(() => localStorage.clear());

  it('remembers when this device first saw the rule, and keeps that time', () => {
    expect(callHangupRuleSince(user, withRule(), 1000, localStorage)).toBe(1000);
    expect(callHangupRuleSince(user, withRule(), 5000, localStorage)).toBe(1000);
  });

  it('forgets the time once the loaded rules carry no enabled rule', () => {
    callHangupRuleSince(user, withRule(), 1000, localStorage);
    expect(callHangupRuleSince(user, withoutRule, 2000, localStorage)).toBeNull();
    expect(callHangupRuleSince(user, withRule(false), 3000, localStorage)).toBeNull();
    expect(callHangupRuleSince(user, withRule(), 4000, localStorage)).toBe(4000);
  });

  it('keeps what it knows while the rules are not loaded', () => {
    expect(callHangupRuleSince(user, undefined, 1000, localStorage)).toBeNull();
    callHangupRuleSince(user, withRule(), 2000, localStorage);
    expect(callHangupRuleSince(user, undefined, 3000, localStorage)).toBe(2000);
  });

  it('keeps accounts apart and ignores an unknown user', () => {
    callHangupRuleSince(user, withRule(), 1000, localStorage);
    expect(callHangupRuleSince('@bob:example.org', undefined, 2000, localStorage)).toBeNull();
    expect(callHangupRuleSince('', withRule(), 2000, localStorage)).toBeNull();
  });

  it('takes nothing back when storage is unavailable', () => {
    const denied = () => { throw new Error('denied'); };
    const broken = { getItem: denied, setItem: denied, removeItem: denied };
    expect(callHangupRuleSince(user, withRule(), 1000, broken)).toBeNull();
  });
});
