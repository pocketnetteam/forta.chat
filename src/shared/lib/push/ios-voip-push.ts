import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * Bridge to the custom Swift `IOSVoIPPushPlugin` (~150 LOC) — see
 * `ios/App/App/IOSVoIPPushPlugin.swift`. Owns the `PKPushRegistry`
 * lifecycle and surfaces:
 *
 *   * `voipTokenReceived` — first issue or rotation of the VoIP push
 *     token (distinct from the regular APNs/FCM token surfaced by
 *     `@capacitor/push-notifications`).
 *   * `voipTokenInvalidated` — iOS revoked the token; JS should drop
 *     the matching Matrix `fortaios.voip` pusher.
 *   * `voipPushReceived` — a VoIP push arrived. By the time this fires,
 *     the Swift side has ALREADY reported a CallKit incoming call to
 *     the OS (mandatory per Apple guidelines) and forwarded the payload
 *     to `@capgo/capacitor-incoming-call-kit` via NotificationCenter.
 *     The JS event is for telemetry / pre-warming the Matrix client
 *     before the user accepts.
 *
 * Used by `push-service.ts` to register a SECOND Matrix pusher with
 * `app_id: 'fortaios.voip'`, separate from the regular `'fortaios'`
 * pusher that handles non-call notifications. See Step 6 / Sygnal config
 * request doc for the homeserver-side configuration.
 */
export interface IOSVoIPPushReceivedPayload {
  callId: string;
  roomId: string;
  callerName: string;
  hasVideo: boolean;
}

export interface IOSVoIPTokenPayload {
  token: string;
}

export interface IOSVoIPPushPlugin {
  /**
   * Read the current VoIP push token. Returns `{ token: null }` when
   * iOS has not yet delivered credentials — callers should additionally
   * subscribe to `voipTokenReceived` to be notified when the token
   * first arrives or is rotated.
   */
  getToken(): Promise<{ token: string | null }>;
  addListener(
    event: 'voipTokenReceived',
    cb: (data: IOSVoIPTokenPayload) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'voipTokenInvalidated',
    cb: () => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'voipPushReceived',
    cb: (data: IOSVoIPPushReceivedPayload) => void,
  ): Promise<PluginListenerHandle>;
}

export const IOSVoIPPush = registerPlugin<IOSVoIPPushPlugin>('IOSVoIPPush');
