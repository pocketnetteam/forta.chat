import { describe, expect, it } from 'vitest';
import {
  PUSHER_APP_ID_ANDROID,
  PUSHER_APP_ID_IOS,
  buildPusherPayload,
  isStalePusherEntry,
  shouldRunJsPushDecryption,
} from './push-service';

describe('buildPusherPayload', () => {
  it('uses fortaios app_id and "iOS" device_display_name on iOS', () => {
    const payload = buildPusherPayload('token-abc', { isIOS: true });
    expect(payload.app_id).toBe(PUSHER_APP_ID_IOS);
    expect(payload.app_id).toBe('fortaios');
    expect(payload.device_display_name).toBe('iOS');
  });

  it('uses fortaandroid app_id and "Android" device_display_name on Android', () => {
    const payload = buildPusherPayload('token-abc', { isIOS: false });
    expect(payload.app_id).toBe(PUSHER_APP_ID_ANDROID);
    expect(payload.app_id).toBe('fortaandroid');
    expect(payload.device_display_name).toBe('Android');
  });

  it('always uses http kind, lang en, and the Sygnal URL', () => {
    const ios = buildPusherPayload('t1', { isIOS: true });
    const android = buildPusherPayload('t2', { isIOS: false });
    for (const p of [ios, android]) {
      expect(p.kind).toBe('http');
      expect(p.lang).toBe('en');
      expect(p.data.url).toBe('https://matrix.pocketnet.app/_matrix/push/v1/notify');
      expect(p.app_display_name).toBe('Forta Chat');
    }
  });

  it('forwards the token verbatim as pushkey (FCM token, not APNs hex)', () => {
    expect(buildPusherPayload('fcm-xyz', { isIOS: true }).pushkey).toBe('fcm-xyz');
    expect(buildPusherPayload('fcm-xyz', { isIOS: false }).pushkey).toBe('fcm-xyz');
  });
});

describe('isStalePusherEntry', () => {
  it('flags same-platform pusher with a different pushkey as stale', () => {
    const stale = isStalePusherEntry(
      { app_id: 'fortaios', pushkey: 'old-token' },
      'fortaios',
      'new-token',
    );
    expect(stale).toBe(true);
  });

  it('does not flag the current pusher (same app_id, same pushkey)', () => {
    const stale = isStalePusherEntry(
      { app_id: 'fortaios', pushkey: 'same-token' },
      'fortaios',
      'same-token',
    );
    expect(stale).toBe(false);
  });

  it('never flags pushers from the other platform', () => {
    // We're on iOS (currentAppId=fortaios). The user is also signed in on an
    // Android device — its fortaandroid pusher must stay untouched.
    const stale = isStalePusherEntry(
      { app_id: 'fortaandroid', pushkey: 'android-device-token' },
      'fortaios',
      'ios-device-token',
    );
    expect(stale).toBe(false);
  });

  it('never flags pushers from a third-party app sharing the matrix account', () => {
    const stale = isStalePusherEntry(
      { app_id: 'im.element.ios', pushkey: 'element-token' },
      'fortaios',
      'forta-token',
    );
    expect(stale).toBe(false);
  });

  it('returns false when app_id is missing on the entry', () => {
    const stale = isStalePusherEntry(
      { pushkey: 'some-token' },
      'fortaios',
      'new-token',
    );
    expect(stale).toBe(false);
  });
});

describe('shouldRunJsPushDecryption', () => {
  it('runs the JS decrypt+replace flow on Android', () => {
    expect(shouldRunJsPushDecryption({ isIOS: false })).toBe(true);
  });

  it('skips the JS decrypt+replace flow on iOS', () => {
    // Step 7's Notification Service Extension renders the final
    // notification at delivery time, and iOS does not allow editing a
    // notification once it is shown — so any JS replacement work would be
    // wasted. Keep this regression test until the contract changes.
    expect(shouldRunJsPushDecryption({ isIOS: true })).toBe(false);
  });
});
