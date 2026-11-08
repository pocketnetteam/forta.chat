import { describe, expect, it } from 'vitest';
import {
  PUSHER_APP_ID_ANDROID,
  PUSHER_APP_ID_IOS,
  PUSHER_APP_ID_IOS_VOIP,
  PUSHER_APP_ID_IOS_VOIP_SANDBOX,
  buildPusherPayload,
  buildVoipPusherPayload,
  isLegacyPusherEntry,
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

  // A build installed from Xcode gets sandbox PushKit tokens, which only the
  // APNs sandbox accepts; Sygnal reaches it through a separate pushkin.
  it('uses fortaios.voip.sandbox for a sandbox token and fortaios.voip otherwise', () => {
    expect(buildVoipPusherPayload('t', 'sandbox').app_id).toBe(PUSHER_APP_ID_IOS_VOIP_SANDBOX);
    expect(PUSHER_APP_ID_IOS_VOIP_SANDBOX).toBe('fortaios.voip.sandbox');
    expect(buildVoipPusherPayload('t', 'production').app_id).toBe('fortaios.voip');
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

// Moving to the `fortachat` Firebase project changes both the FCM token and
// the app_id (fortaandroid -> fortaandroid2): the device's old pusher matched
// neither stale rule and doubled every push.
describe('isLegacyPusherEntry', () => {
  it('flags the old-project pusher of this device whatever its app_id', () => {
    expect(isLegacyPusherEntry({ pushkey: 'old-token' }, 'old-token', 'new-token')).toBe(true);
  });

  it('leaves other devices alone', () => {
    expect(isLegacyPusherEntry({ pushkey: 'other-device' }, 'old-token', 'new-token')).toBe(false);
  });

  it('flags nothing without a legacy token', () => {
    expect(isLegacyPusherEntry({ pushkey: 'old-token' }, null, 'new-token')).toBe(false);
  });

  it('never flags the pusher just registered', () => {
    expect(isLegacyPusherEntry({ pushkey: 'same' }, 'same', 'same')).toBe(false);
  });
});
