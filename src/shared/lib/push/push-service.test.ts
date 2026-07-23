import { describe, expect, it } from 'vitest';
import {
  PUSHER_APP_ID_ANDROID,
  PUSHER_APP_ID_IOS,
  PUSHER_APP_ID_IOS_VOIP,
  buildPusherPayload,
  buildVoipPusherPayload,
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

describe('buildVoipPusherPayload (iOS PushKit)', () => {
  it('uses the dedicated fortaios.voip app_id (separate from the regular fortaios pusher)', () => {
    const payload = buildVoipPusherPayload('voip-token-xyz');
    expect(payload.app_id).toBe(PUSHER_APP_ID_IOS_VOIP);
    expect(payload.app_id).toBe('fortaios.voip');
    // Critical: the VoIP pusher MUST NOT collide with the regular
    // fortaios pusher's app_id, otherwise Sygnal would route
    // m.room.message events through PushKit (Apple-forbidden) or
    // m.call.invite events through normal APNs (no CallKit ringer).
    expect(payload.app_id).not.toBe(PUSHER_APP_ID_IOS);
  });

  it('uses the VoIP token verbatim as pushkey (PKPushCredentials.token, NOT the regular APNs/FCM token)', () => {
    expect(buildVoipPusherPayload('pkt-abc').pushkey).toBe('pkt-abc');
  });

  it('marks the device as "iOS (VoIP)" so getPushers() shows it as separate from the regular iOS pusher', () => {
    const payload = buildVoipPusherPayload('t');
    expect(payload.device_display_name).toBe('iOS (VoIP)');
  });

  it('reuses the same Sygnal http URL and lang as the regular pusher', () => {
    const voip = buildVoipPusherPayload('t1');
    const regular = buildPusherPayload('t2', { isIOS: true });
    expect(voip.kind).toBe('http');
    expect(voip.lang).toBe('en');
    expect(voip.data.url).toBe(regular.data.url);
    expect(voip.app_display_name).toBe('Forta Chat');
  });
});

describe('isStalePusherEntry — VoIP pusher cleanup', () => {
  it('flags a stale fortaios.voip pusher when the VoIP token rotated', () => {
    const stale = isStalePusherEntry(
      { app_id: 'fortaios.voip', pushkey: 'old-voip-token' },
      'fortaios.voip',
      'new-voip-token',
    );
    expect(stale).toBe(true);
  });

  it('does NOT flag the regular fortaios pusher when cleaning the VoIP one', () => {
    // We're cleaning fortaios.voip with a new VoIP token. The regular
    // fortaios pusher (different app_id, different token) must stay.
    const stale = isStalePusherEntry(
      { app_id: 'fortaios', pushkey: 'fcm-token' },
      'fortaios.voip',
      'voip-token',
    );
    expect(stale).toBe(false);
  });

  it('does NOT flag the VoIP pusher when cleaning the regular fortaios one', () => {
    // Symmetric guard: don't accidentally drop the VoIP pusher when
    // re-registering the regular FCM-backed iOS pusher.
    const stale = isStalePusherEntry(
      { app_id: 'fortaios.voip', pushkey: 'voip-token' },
      'fortaios',
      'new-fcm-token',
    );
    expect(stale).toBe(false);
  });
});
