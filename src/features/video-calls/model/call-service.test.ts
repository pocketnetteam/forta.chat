// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  mockEnsureCallPermissions,
  mockSetMatrixCall,
  mockCallStore,
  mockPlaceVoiceCall,
  mockAnswer,
  mockReject,
  mockOn,
  mockOff,
  resetCallServiceHarness,
} from './call-service.harness';

describe('call-service: the call slot and the native call screen', () => {
  beforeEach(resetCallServiceHarness);

  // -------------------------------------------------------------------------
  // WEE-54 / forta-bugs#866 — phantom ringback tone.
  //
  // The local ringback ("гудки") used to play synchronously inside
  // startCallInner *before* placeVoiceCall() ran, so it sounded during local
  // getUserMedia + offer creation, and even when the invite never reached the
  // homeserver. Users perceived this as ringback "when the peer device was
  // off". The fix gates the ringback on the SDK's InviteSent state (invite
  // actually delivered to the server) inside wireCallEvents.
  // -------------------------------------------------------------------------
  describe('single call slot during a native ring (#1183)', () => {
    // On Android an incoming call rings through Telecom and the CallInfo is
    // only written once the user answers, so `isInCall` is false for the
    // whole ring while `matrixCall` already holds the SDK object. Guards
    // keyed on `isInCall` let a second call overwrite that single slot, and
    // the call the user then answered had already been unwired.

    it('refuses to dial while a call is ringing but not yet answered', async () => {
      mockCallStore.isInCall = false; // no CallInfo yet — the native ring window
      mockCallStore.hasLiveCall = true;

      const { useCallService } = await import('./call-service');
      await useCallService().startCall('!room:matrix.org', 'voice');

      expect(mockEnsureCallPermissions).not.toHaveBeenCalled();
      expect(mockPlaceVoiceCall).not.toHaveBeenCalled();
    });

    it('rejects a second incoming call that arrives during that same window', async () => {
      mockCallStore.isInCall = false;
      mockCallStore.hasLiveCall = true;

      const { useCallService } = await import('./call-service');
      const second = {
        callId: 'second-invite',
        roomId: '!room:matrix.org',
        type: 'voice',
        on: mockOn,
        off: mockOff,
        answer: mockAnswer,
        reject: mockReject,
        getOpponentMember: vi.fn(() => ({ userId: '@peer:matrix.org' })),
      };
      await useCallService().handleIncomingCall(second as never);

      expect(mockReject).toHaveBeenCalled();
      expect(mockSetMatrixCall).not.toHaveBeenCalled();
    });

    it('still dials when nothing holds the slot', async () => {
      const { useCallService } = await import('./call-service');
      await useCallService().startCall('!room:matrix.org', 'voice');

      expect(mockEnsureCallPermissions).toHaveBeenCalledWith(false);
    });
  });

  describe('currentCall()', () => {
    // Read by the native bridge to decide whether a callEnded/callDeclined is
    // about the call JS is holding. It only means anything while it reports the
    // same call `hangup`/`rejectCall` would act on — both read
    // `callStore.matrixCall` fresh on every invocation, so this must too. A
    // cached ref here would put the guard back to comparing against a stale id,
    // which is the state that let the wrong call be torn down.
    it('reports the call hangup and rejectCall would act on', async () => {
      mockCallStore.matrixCall = { callId: 'call-a', roomId: '!a:matrix.org' };

      const { useCallService } = await import('./call-service');

      expect(useCallService().currentCall()).toEqual({
        callId: 'call-a',
        roomId: '!a:matrix.org',
      });
    });

    it('follows the store rather than caching what it saw first', async () => {
      mockCallStore.matrixCall = { callId: 'call-a', roomId: '!a:matrix.org' };

      const { useCallService } = await import('./call-service');
      const service = useCallService();
      expect(service.currentCall().callId).toBe('call-a');

      mockCallStore.matrixCall = { callId: 'call-b', roomId: '!b:matrix.org' };

      expect(service.currentCall().callId).toBe('call-b');
    });

    it('reports an undefined callId when JS holds no call', async () => {
      mockCallStore.matrixCall = null;

      const { useCallService } = await import('./call-service');

      expect(useCallService().currentCall().callId).toBeUndefined();
    });
  });

  describe('native call screen launch site', () => {
    it('launches the native call screen only through the helper that keeps the page audible', () => {
      // The tests above cover today's three launches. A fourth one calling
      // NativeWebRTC.launchCallUI directly would bring the frozen page back
      // for its calls, so every launch has to go through one place.
      // The call service is split across call-*.ts modules; the rule covers all of them.
      const strip = (text: string) => text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const serviceModules = readdirSync(__dirname).filter((f) => /^call-.*\.ts$/.test(f) && !f.endsWith('.test.ts'));
      const all = serviceModules.map((f) => strip(readFileSync(resolve(__dirname, f), 'utf-8'))).join('\n');
      const code = strip(readFileSync(resolve(__dirname, 'call-native-screen.ts'), 'utf-8'));

      expect(all.match(/NativeWebRTC\.launchCallUI\(/g)).toHaveLength(1);
      // Android only: the freeze is Chromium's, and NativeWebRTC is an
      // Android plugin — on iOS the launch rejected with UNIMPLEMENTED on
      // every call, and a tone would share the audio session with the call.
      expect(code).toMatch(
        /if \(!isAndroid\) return Promise\.resolve\(\);\s*holdPageAwake\(options\.callId\);\s*return NativeWebRTC\.launchCallUI\(options\);/,
      );
    });
  });
});
