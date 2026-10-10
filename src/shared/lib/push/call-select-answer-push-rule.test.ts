// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  CALL_SELECT_ANSWER_PUSH_RULE_ID,
  CALL_SELECT_ANSWER_PUSH_RULE_KIND,
  buildCallSelectAnswerPushRule,
  callSelectAnswerRuleSince,
  findCallSelectAnswerPushRule,
} from './call-select-answer-push-rule';
import { CALL_HANGUP_PUSH_RULE_ID, callHangupRuleSince } from './call-hangup-push-rule';

/**
 * The account push rule that makes the homeserver push `m.call.select_answer`.
 *
 * With Forta's page frozen in the background the phone kept ringing for 30 s while the
 * user already talked in Bastyon on the same account (forta-bugs#809, `dualb6`). With a
 * temporary rule on the test account the push arrived about a second after the answer
 * (`saprobe3`, 2026-09-18).
 */
describe('call select_answer push rule', () => {
  it('matches m.call.select_answer and only notifies — no sound, no highlight', () => {
    expect(buildCallSelectAnswerPushRule()).toEqual({
      conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.call.select_answer' }],
      actions: ['notify'],
    });
  });

  it('lives in underride under the app namespace, apart from the hangup rule', () => {
    expect(CALL_SELECT_ANSWER_PUSH_RULE_KIND).toBe('underride');
    expect(CALL_SELECT_ANSWER_PUSH_RULE_ID).toBe('com.forta.call.select_answer');
    expect(CALL_SELECT_ANSWER_PUSH_RULE_ID).not.toBe(CALL_HANGUP_PUSH_RULE_ID);
  });

  it('is found among the global underride rules, and the hangup rule does not pass for it', () => {
    const rule = { rule_id: CALL_SELECT_ANSWER_PUSH_RULE_ID, enabled: true };
    expect(findCallSelectAnswerPushRule({ global: { underride: [{ rule_id: CALL_HANGUP_PUSH_RULE_ID }, rule] } })).toBe(rule);
    expect(findCallSelectAnswerPushRule({ global: { underride: [{ rule_id: CALL_HANGUP_PUSH_RULE_ID }] } })).toBeUndefined();
    expect(findCallSelectAnswerPushRule(undefined)).toBeUndefined();
  });
});

describe('callSelectAnswerRuleSince', () => {
  const user = '@alice:example.org';
  const rules = (...ids: string[]) => ({ global: { underride: ids.map((rule_id) => ({ rule_id, enabled: true })) } });

  beforeEach(() => localStorage.clear());

  it('is dated apart from the hangup rule the account already had', () => {
    expect(callHangupRuleSince(user, rules(CALL_HANGUP_PUSH_RULE_ID), 1000, localStorage)).toBe(1000);
    expect(callSelectAnswerRuleSince(user, rules(CALL_HANGUP_PUSH_RULE_ID), 2000, localStorage)).toBeNull();

    const both = rules(CALL_HANGUP_PUSH_RULE_ID, CALL_SELECT_ANSWER_PUSH_RULE_ID);
    expect(callSelectAnswerRuleSince(user, both, 5000, localStorage)).toBe(5000);
    expect(callSelectAnswerRuleSince(user, both, 9000, localStorage)).toBe(5000);
    expect(callHangupRuleSince(user, both, 9000, localStorage)).toBe(1000);
  });

  it('forgets the time once the rule is gone, and answers from storage while rules are not loaded', () => {
    callSelectAnswerRuleSince(user, rules(CALL_SELECT_ANSWER_PUSH_RULE_ID), 1000, localStorage);
    expect(callSelectAnswerRuleSince(user, undefined, 2000, localStorage)).toBe(1000);
    expect(callSelectAnswerRuleSince(user, rules(CALL_HANGUP_PUSH_RULE_ID), 3000, localStorage)).toBeNull();
    expect(callSelectAnswerRuleSince(user, undefined, 4000, localStorage)).toBeNull();
  });
});
