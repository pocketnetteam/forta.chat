import { PushNotifications } from '@capacitor/push-notifications';
import { LocalNotifications } from '@capacitor/local-notifications';
import { isIOS, isNative } from '@/shared/lib/platform';
import { PushData, type PushPayload } from './push-data-plugin';
import { IOSVoIPPush } from './ios-voip-push';
import { shouldRingForCallPush } from './call-push-dedup';
import { tRaw } from '@/shared/lib/i18n';
import { interopLog } from '@/shared/lib/interop';

/**
 * Sygnal `app_id` per platform. Both pushers can coexist on the same Matrix
 * account when a user is signed in on multiple devices; cleanup of stale
 * pushkeys is scoped to the device's own `app_id` so iOS does not delete
 * Android's pusher and vice versa.
 *
 * iOS uses TWO pushers in parallel:
 *   - `fortaios`     → regular APNs (FCM token) for non-call notifications.
 *   - `fortaios.voip` → APNs VoIP class (PushKit token) for `m.call.invite`
 *                      events only. Apple guidelines forbid using PushKit
 *                      for anything else, so Sygnal is configured to route
 *                      only `msg_type == m.call.invite[.video]` to this
 *                      pusher (see SYGNAL-CONFIG-REQUEST.md).
 */
export const PUSHER_APP_ID_IOS = 'fortaios';
export const PUSHER_APP_ID_IOS_VOIP = 'fortaios.voip';
export const PUSHER_APP_ID_ANDROID = 'fortaandroid';
const SYGNAL_PUSH_URL = 'https://matrix.pocketnet.app/_matrix/push/v1/notify';

export interface PusherPayload {
  pushkey: string;
  kind: 'http';
  app_id: string;
  app_display_name: string;
  device_display_name: string;
  lang: string;
  data: { url: string };
}

/**
 * Build the per-platform pusher payload. Pure function — exported for unit
 * tests. iOS flows through Firebase iOS SDK → APNs (Apple delivers via Sygnal
 * with `app_id: fortaios`). Android flows through FCM directly.
 */
export function buildPusherPayload(token: string, opts: { isIOS: boolean }): PusherPayload {
  return {
    pushkey: token,
    kind: 'http',
    app_id: opts.isIOS ? PUSHER_APP_ID_IOS : PUSHER_APP_ID_ANDROID,
    app_display_name: 'Forta Chat',
    device_display_name: opts.isIOS ? 'iOS' : 'Android',
    lang: 'en',
    data: { url: SYGNAL_PUSH_URL },
  };
}

/**
 * Build the iOS VoIP pusher payload (PushKit). The pushkey is the VoIP
 * push token from `PKPushRegistry`, which is DIFFERENT from the regular
 * APNs/FCM token used by {@link buildPusherPayload}. Sygnal routes only
 * `m.call.invite[.video]` events to this pusher and uses APNs VoIP class
 * instead of normal-priority APNs so the OS wakes the app even from cold.
 *
 * Pure function — exported for unit tests. The returned `device_display_name`
 * is intentionally distinct from the regular `'iOS'` pusher so the user
 * can tell them apart in `getPushers()` listings.
 */
export function buildVoipPusherPayload(voipToken: string): PusherPayload {
  return {
    pushkey: voipToken,
    kind: 'http',
    app_id: PUSHER_APP_ID_IOS_VOIP,
    app_display_name: 'Forta Chat',
    device_display_name: 'iOS (VoIP)',
    lang: 'en',
    data: { url: SYGNAL_PUSH_URL },
  };
}

/**
 * Decide whether a pusher entry from `getPushers()` is stale and should be
 * removed. Stale = same `app_id` as our current platform's pusher but a
 * different `pushkey`. We never touch entries from other platforms — those
 * belong to other devices on this Matrix account.
 */
export function isStalePusherEntry(
  p: { app_id?: string; pushkey?: string },
  currentAppId: string,
  currentToken: string,
): boolean {
  return p.app_id === currentAppId && p.pushkey !== currentToken;
}

/**
 * Whether the JS-side `tryDecryptAndReplace` flow should run.
 *
 * Android: yes. The native PushDataPlugin shows a placeholder notification
 * on receive, and JS later replaces its title/body once Matrix sync delivers
 * and decrypts the event.
 *
 * iOS: no. The Notification Service Extension (Step 7) renders the final
 * notification at delivery time, and iOS forbids editing notifications that
 * are already on screen. Running the JS replacement path would do work for
 * no observable effect.
 */
export function shouldRunJsPushDecryption(opts: { isIOS: boolean }): boolean {
  return !opts.isIOS;
}

class PushService {
  private fcmToken: string | null = null;
  private matrixClient: any = null;
  private onCallPush: ((data: { callId: string; callerName: string; roomId: string; hasVideo: boolean }) => void) | null = null;
  private getRoomInfo: ((roomId: string) => { roomName: string } | null) | null = null;
  private getActiveRoomId: (() => string | null) | null = null;
  private getAllRoomNames: (() => Record<string, string>) | null = null;
  private getAllSenderNames: (() => Record<string, string>) | null = null;
  /** Callback to optimistically update room preview in Dexie when push arrives.
   *  Wired from auth store after ChatDbKit is initialized. */
  private optimisticRoomUpdate: ((roomId: string, preview: string, timestamp: number, senderId?: string, eventId?: string) => Promise<boolean>) | null = null;

  setCallHandler(handler: typeof this.onCallPush) {
    this.onCallPush = handler;
  }

  setRoomInfoGetter(getter: typeof this.getRoomInfo) {
    this.getRoomInfo = getter;
  }

  setActiveRoomGetter(getter: () => string | null) {
    this.getActiveRoomId = getter;
  }

  setAllRoomNamesGetter(getter: () => Record<string, string>) {
    this.getAllRoomNames = getter;
  }

  setAllSenderNamesGetter(getter: () => Record<string, string>) {
    this.getAllSenderNames = getter;
  }

  /** Set the callback for optimistic room preview updates from push notifications.
   *  Called from auth store once ChatDbKit is ready. */
  setOptimisticRoomUpdater(updater: typeof this.optimisticRoomUpdate) {
    this.optimisticRoomUpdate = updater;
  }

  /** Push all known room names to native SharedPreferences for offline display */
  async syncRoomNamesToNative(): Promise<void> {
    if (!this.getAllRoomNames) return;
    try {
      const rooms = this.getAllRoomNames();
      if (Object.keys(rooms).length > 0) {
        await PushData.cacheRoomNames({ rooms });
      }
    } catch (e) {
      console.warn('[PushService] Failed to sync room names to native:', e);
    }
  }

  /** Push all known sender display names to native SharedPreferences */
  async syncSenderNamesToNative(): Promise<void> {
    if (!this.getAllSenderNames) return;
    try {
      const senders = this.getAllSenderNames();
      if (Object.keys(senders).length > 0) {
        await PushData.cacheSenderNames({ senders });
      }
    } catch (e) {
      console.warn('[PushService] Failed to sync sender names to native:', e);
    }
  }

  /** Retry budget for setPusher. With 3 attempts and exponential backoff
   *  (1s, 2s, 4s) we cover transient network blips and short Matrix homeserver
   *  hiccups without blocking the boot path for more than ~7 seconds. */
  private static readonly PUSHER_REGISTER_RETRIES = 3;

  /** WEE-11 / forta-bugs#686: short pause before the FAST PATH fetch so the
   *  homeserver has time to index the event the FCM push referred to.
   *  Cold-start pushes often arrive ahead of indexing; without the grace the
   *  targeted fetch 404s, we fall through to the 15s timeline-wait, and the
   *  user keeps staring at the raw Matrix ID. 500ms is well below the push
   *  UX budget (total path stays under 1.5s) and well above measured
   *  homeserver indexing latency. */
  private static readonly TARGETED_FETCH_GRACE_MS = 500;

  /** Sleep helper kept inline to avoid a util import for one call site. */
  private static sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async registerPusher(matrixClient: any, token: string): Promise<void> {
    // WEE-44 (H1, forta-bugs#766/#572/#356/#344/#556): the original code did
    // `await setPusher(...)` once and swallowed the error. A single transient
    // failure (network blip, 5xx from /_matrix/push, slow Matrix sync) left
    // the device with a valid FCM token that the homeserver had never been
    // told about — so no push ever arrived for that session.
    // iOS/Android use buildPusherPayload so app_id stays platform-correct.
    const payload = buildPusherPayload(token, { isIOS });
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= PushService.PUSHER_REGISTER_RETRIES; attempt++) {
      try {
        await matrixClient.setPusher(payload);
        if (attempt > 1) {
          console.info(`[PushService] Pusher registered on attempt ${attempt}`);
        }
        // Pusher is live — best-effort stale cleanup is a separate concern;
        // its failure must not invalidate the successful registration above.
        try {
          const { pushers } = await matrixClient.getPushers();
          for (const p of pushers) {
            if (isStalePusherEntry(p, payload.app_id, token)) {
              await matrixClient.setPusher({ ...p, kind: null });
            }
          }
        } catch (pe) {
          console.warn('[PushService] Could not clean stale pushers:', pe);
        }
        return;
      } catch (e) {
        lastError = e;
        if (attempt < PushService.PUSHER_REGISTER_RETRIES) {
          const delay = 1000 * 2 ** (attempt - 1); // 1s, 2s
          console.warn(
            `[PushService] setPusher attempt ${attempt}/${PushService.PUSHER_REGISTER_RETRIES} failed, retrying in ${delay}ms:`,
            e,
          );
          await PushService.sleep(delay);
        }
      }
    }
    // Dead-letter: all retries exhausted. Stash the token + timestamp so a
    // later boot can re-attempt registration even if the user does not
    // explicitly re-trigger PushNotifications.register().
    console.error(
      '[PushService] Pusher registration failed permanently after',
      PushService.PUSHER_REGISTER_RETRIES,
      'attempts:',
      lastError,
    );
    try {
      localStorage.setItem(
        'push_pusher_dead_letter',
        JSON.stringify({ token, at: Date.now(), error: String(lastError) }),
      );
    } catch {
      /* localStorage may be unavailable in degraded WebViews — non-fatal */
    }
  }

  /**
   * Register the iOS VoIP (PushKit) pusher for `m.call.invite` events.
   *
   * Idempotent: safe to call on every `voipTokenReceived` event including
   * rotations. Cleans up stale `fortaios.voip` pushers from previous
   * tokens on this device — without this, every reinstall + new token
   * would leave a dead pusher on the homeserver and Sygnal would keep
   * trying to deliver to gone-app tokens forever.
   */
  private async registerVoipPusher(matrixClient: any, voipToken: string): Promise<void> {
    if (!matrixClient) return;
    const payload = buildVoipPusherPayload(voipToken);
    try {
      await matrixClient.setPusher(payload);
      try {
        const { pushers } = await matrixClient.getPushers();
        for (const p of pushers) {
          if (isStalePusherEntry(p, payload.app_id, voipToken)) {
            await matrixClient.setPusher({ ...p, kind: null });
          }
        }
      } catch (pe) {
        console.warn('[PushService] Could not clean stale VoIP pushers:', pe);
      }
    } catch (e) {
      console.error('[PushService] Failed to register VoIP pusher:', e);
    }
  }

  /**
   * Wait for the event to arrive via sync and be decrypted by the SDK,
   * then replace the native notification with the decrypted content.
   *
   * iOS no-op: the Notification Service Extension (Step 7) produces the
   * final user-facing notification at delivery time, and iOS does not
   * allow editing already-shown notifications. Skipping the decrypt+replace
   * dance avoids a redundant Matrix fetch and removes the only Android-only
   * code path from the iOS push pipeline.
   */
  private async tryDecryptAndReplace(data: PushPayload): Promise<void> {
    if (!shouldRunJsPushDecryption({ isIOS })) return;
    const { room_id: roomId, event_id: eventId } = data;
    if (!roomId || !this.matrixClient) return;

    try {
      // 1. Already in timeline?
      const existing = this.findDecryptedEvent(roomId, eventId);
      if (existing) {
        await this.replaceNotification(roomId, eventId, existing);
        return;
      }

      // 2. FAST PATH: targeted fetch with a short grace delay.
      // WEE-11 / forta-bugs#686: homeserver event indexing can lag the FCM
      // delivery by ~200-500ms — fetching the event_id immediately returns
      // 404 and we fall through to the 15s timeline-wait path, leaving the
      // raw-Matrix-ID title on screen. A small grace gives the homeserver
      // time to index the event before we ask for it.
      if (eventId) {
        const fetched = await this.tryTargetedFetch(roomId, eventId, {
          graceMs: PushService.TARGETED_FETCH_GRACE_MS,
        });
        if (fetched) {
          await this.replaceNotification(roomId, eventId, fetched);
          return;
        }
      }

      // 3. SLOW PATH: wait for sync
      const result = await this.waitForDecryptedEvent(roomId, eventId, 15000);
      if (!result) return;
      await this.replaceNotification(roomId, eventId, result);
    } catch (e) {
      console.warn('[PushService] Decrypt failed, keeping native notification:', e);
    }
  }

  /**
   * Extract message from a directly-fetched event.
   *
   * `opts.graceMs` (WEE-11 / forta-bugs#686): wait this long before issuing
   * the fetch so the homeserver has time to index the event the push
   * referred to. Without the grace, cold-start pushes routinely 404 on the
   * first hit and we fall through to the slow timeline-wait path, leaving
   * the raw Matrix ID visible as the notification title for 15s.
   */
  private async tryTargetedFetch(
    roomId: string,
    eventId: string,
    opts: { graceMs?: number } = {},
  ): Promise<{ senderName: string; body: string } | null> {
    try {
      const graceMs = opts.graceMs ?? 0;
      if (graceMs > 0) {
        await PushService.sleep(graceMs);
      }
      const { getMatrixClientService } = await import("@/entities/matrix/model/matrix-client");
      const matrixService = getMatrixClientService();
      const raw = await matrixService.fetchRoomEvent(roomId, eventId);
      if (!raw) return null;

      if (raw.type === "m.room.message") {
        const content = raw.content as Record<string, unknown>;
        const body = content?.body;
        if (body && typeof body === "string") {
          // Skip if body is still ciphertext (base64 blob — Bastyon E2EE wraps
          // encrypted payloads inside m.room.message with a base64-encoded body)
          if (/^[A-Za-z0-9+/]{50,}={0,2}$/.test(body)) return null;
          // Resolve display name from room member state instead of raw matrix ID
          const senderId = raw.sender as string;
          const room = this.matrixClient?.getRoom(roomId);
          const member = room?.getMember(senderId);
          const senderName = member?.name || senderId || tRaw('push.unknownSender');
          return { senderName, body: this.formatBody(content) };
        }
      }
      // Encrypted messages need SDK decryption — fall through
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Replace native notification with decrypted content.
   * Uses native PushDataPlugin.replaceNotificationContent() instead of
   * Capacitor LocalNotifications.schedule() — this keeps the native PendingIntent
   * with push_room_id/push_event_id extras, ensuring tap navigation works
   * consistently (including cold-start via bufferPushIntent).
   */
  private async replaceNotification(
    roomId: string,
    eventId: string | undefined,
    result: { senderName: string; body: string },
  ): Promise<void> {
    await PushData.replaceNotificationContent({
      roomId,
      eventId,
      title: result.senderName,
      body: result.body,
    });
  }

  /**
   * Wait for a decrypted event to appear in the room timeline.
   * Sync delivers the event → SDK decrypts it → Event.decrypted fires.
   */
  private waitForDecryptedEvent(
    roomId: string,
    eventId: string | undefined,
    timeoutMs: number,
  ): Promise<{ senderName: string; body: string } | null> {
    return new Promise((resolve) => {
      const client = this.matrixClient;
      if (!client) { resolve(null); return; }

      // First check if event is already in timeline (sync may have beaten the push)
      const existing = this.findDecryptedEvent(roomId, eventId);
      if (existing) { resolve(existing); return; }

      let resolved = false;
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        client.removeListener('Room.timeline', onTimeline);
        client.removeListener('Event.decrypted', onDecrypted);
      };

      const tryExtract = (event: any): { senderName: string; body: string } | null => {
        const evId = event.getId?.();
        const evType = event.getType?.();
        if (eventId && evId !== eventId) return null;
        if (evType !== 'm.room.message') return null;
        if (event.isDecryptionFailure?.()) return null;
        const content = event.getContent?.();
        const body = content?.body;
        if (!body || typeof body !== 'string') return null;
        // Skip if body is still ciphertext (base64 blob)
        if (/^[A-Za-z0-9+/]{50,}={0,2}$/.test(body)) return null;
        const senderName = event.sender?.name || event.getSender?.() || tRaw('push.unknownSender');
        return { senderName, body: this.formatBody(content) };
      };

      const onTimeline = (event: any, room: any) => {
        if (resolved) return;
        if (room?.roomId !== roomId) return;
        const result = tryExtract(event);
        if (result) { cleanup(); resolve(result); }
      };

      const onDecrypted = (event: any) => {
        if (resolved) return;
        if (event.getRoomId?.() !== roomId) return;
        const result = tryExtract(event);
        if (result) { cleanup(); resolve(result); }
      };

      const timer = setTimeout(() => {
        if (resolved) return;
        cleanup();
        // Last attempt: check timeline once more
        resolve(this.findDecryptedEvent(roomId, eventId));
      }, timeoutMs);

      client.on('Room.timeline', onTimeline);
      client.on('Event.decrypted', onDecrypted);
    });
  }

  /** Search room timeline for a specific decrypted event */
  private findDecryptedEvent(
    roomId: string,
    eventId: string | undefined,
  ): { senderName: string; body: string } | null {
    const room = this.matrixClient?.getRoom(roomId);
    if (!room) return null;
    const events = room.getLiveTimeline().getEvents();
    // Search backwards (newest first)
    for (let i = events.length - 1; i >= Math.max(0, events.length - 5); i--) {
      const ev = events[i];
      if (eventId && ev.getId?.() !== eventId) continue;
      if (ev.getType?.() !== 'm.room.message') continue;
      if (ev.isDecryptionFailure?.()) continue;
      const content = ev.getContent?.();
      const body = content?.body;
      if (!body || typeof body !== 'string') continue;
      if (/^[A-Za-z0-9+/]{50,}={0,2}$/.test(body)) continue;
      const senderName = ev.sender?.name || ev.getSender?.() || tRaw('push.unknownSender');
      return { senderName, body: this.formatBody(content) };
    }
    return null;
  }

  /** Format message body based on msgtype */
  private formatBody(content: any): string {
    const msgtype = content?.msgtype;
    const body = content?.body || tRaw('push.newMessage');
    switch (msgtype) {
      case 'm.image': return tRaw('push.photo');
      case 'm.video': return tRaw('push.video');
      case 'm.audio': return tRaw('push.voiceMessage');
      case 'm.file': return `${tRaw('push.file')} ${body}`;
      default: return body;
    }
  }

  /** Handle push data forwarded from native FortaFirebaseMessagingService */
  private handlePushFromNative(data: PushPayload): void {
    const roomId = data.room_id;
    if (!roomId) return;

    // handle push forwarded from native

    // Handle calls
    if (data.msg_type === 'm.call.invite') {
      // Prefer the stable Matrix call_id over event_id: caller clients
      // resend m.call.invite with a new event_id each retry while keeping
      // the call_id constant. Session 41.
      const callId = data.call_id || data.event_id || '';

      // WEE-35: drop a duplicate call push (FCM retry / multi-delivery) so we
      // don't fire the native ringer twice for one call. Push-private window —
      // does NOT dedup against the real /sync MatrixCall (see call-push-dedup).
      if (!shouldRingForCallPush(callId)) {
        interopLog('push', 'duplicate call push suppressed', { callId, roomId });
        return;
      }
      interopLog('push', 'call push → ring', { callId, roomId });

      this.onCallPush?.({
        callId,
        callerName: data.sender_display_name || tRaw('push.unknownSender'),
        roomId,
        hasVideo: false,
      });
      return;
    }

    // Suppress notification if user is actively viewing this chat (app in foreground + room open)
    if (!document.hidden && this.getActiveRoomId?.() === roomId) {
      PushData.cancelNotification({ roomId }).catch(() => {});
      return;
    }

    // Optimistic room preview update — make the room list reflect this push
    // IMMEDIATELY, before /sync completes. Fire-and-forget: errors are non-fatal.
    // The monotonic guard in optimisticUpdateFromPush ensures this never
    // overwrites newer data that EventWriter already wrote from /sync.
    if (this.optimisticRoomUpdate) {
      // Build a minimal content-like object for formatBody (it expects { msgtype, body })
      const preview = this.formatBody({
        msgtype: data.content_msgtype || 'm.text',
        body: tRaw('push.newMessage'),
      });
      const ts = Date.now(); // Server timestamp not available in push — use local time.
                             // EventWriter's updateLastMessage will overwrite with real ts.
      // Pass event_id so updateLastMessage can recognize "same event"
      // and replace this optimistic placeholder when /sync delivers the
      // real (decrypted) body — see room-repository.ts updateLastMessage.
      this.optimisticRoomUpdate(roomId, preview, ts, data.sender, data.event_id).catch(() => {});
    }

    // Try to decrypt and show rich notification
    if (data.event_id) {
      this.tryDecryptAndReplace(data);
    }
  }

  async init(matrixClient: any): Promise<void> {
    if (!isNative) return;

    this.matrixClient = matrixClient;
    // init push service

    // 1. Request notification permission (Android 13+ shows OS dialog)
    const currentStatus = await PushNotifications.checkPermissions();
    if (currentStatus.receive !== 'granted') {
      const permission = await PushNotifications.requestPermissions();
      if (permission.receive !== 'granted') {
        console.warn('[PushService] Push permission not granted');
      }
    }

    // 2. Create notification channels
    await LocalNotifications.requestPermissions();
    await LocalNotifications.createChannel({
      id: 'messages',
      name: tRaw('channel.messages'),
      description: tRaw('channel.messagesDesc'),
      importance: 4,
      sound: 'default',
      vibration: true,
    });
    await LocalNotifications.createChannel({
      id: 'calls',
      name: tRaw('channel.calls'),
      description: tRaw('channel.callsDesc'),
      importance: 5,
      sound: 'ringtone',
      vibration: true,
    });

    // 3. Listen for push data forwarded from native service
    PushData.addListener('pushReceived', (data) => {
      this.handlePushFromNative(data as PushPayload);
    });

    // Listen for notification tap (Android source: PushDataPlugin emits
    // pushOpenRoom directly; on iOS the native PushData plugin no longer
    // emits this — see iOS handler below).
    PushData.addListener('pushOpenRoom', (data) => {
      // push tap → open room
      window.dispatchEvent(new CustomEvent('push:openRoom', {
        detail: { roomId: data.roomId, eventId: data.eventId },
      }));
    });

    // iOS-specific tap source. UNUserNotificationCenter.delegate is owned
    // by Capacitor's runtime; foreground/background taps surface as the
    // standard PushNotifications.pushNotificationActionPerformed event.
    // Cold-start taps are still buffered into PushData.getPendingIntent()
    // by the native IOSPushIntent plugin.
    if (isIOS) {
      PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        const data = (action.notification.data ?? {}) as Record<string, unknown>;
        const roomId = typeof data.room_id === 'string' ? data.room_id : undefined;
        if (!roomId) return;
        const eventId = typeof data.event_id === 'string' ? data.event_id : undefined;
        window.dispatchEvent(new CustomEvent('push:openRoom', {
          detail: { roomId, eventId },
        }));
      });
    }

    // Tap on local notification (shown by JS after decryption)
    LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      const { room_id } = action.notification.extra || {};
      if (room_id) {
        window.dispatchEvent(new CustomEvent('push:openRoom', { detail: { roomId: room_id } }));
      }
    });

    // Check for buffered push intent from cold-start (native fired before JS was ready)
    try {
      const pending = await PushData.getPendingIntent();
      if (pending.roomId) {
        console.log('[PushService] Found pending push intent from cold start:', pending.roomId);
        window.dispatchEvent(new CustomEvent('push:openRoom', {
          detail: { roomId: pending.roomId, eventId: pending.eventId },
        }));
      }
    } catch (e) {
      console.warn('[PushService] Failed to check pending intent:', e);
    }

    // 4. Register for FCM (skip when google-services.json was not bundled — crashes otherwise)
    let fcmAvailable = true;
    try {
      const status = await PushData.isFcmAvailable();
      fcmAvailable = status.available;
    } catch (e) {
      console.warn('[PushService] isFcmAvailable check failed, assuming FCM disabled:', e);
      fcmAvailable = false;
    }

    if (!fcmAvailable) {
      console.warn(
        '[PushService] FCM not configured (no google-services.json at build time) — skipping PushNotifications.register()',
      );
      return;
    }

    await PushNotifications.removeAllListeners();

    PushNotifications.addListener('registration', async ({ value: token }) => {
      // FCM token received
      this.fcmToken = token;
      await this.registerPusher(matrixClient, token);
      // WEE-44: if a previous boot left a dead-letter for the same token,
      // a successful registration just now means we can safely clear it.
      try {
        const raw = localStorage.getItem('push_pusher_dead_letter');
        if (raw) {
          const dl = JSON.parse(raw) as { token?: string };
          if (dl?.token === token) localStorage.removeItem('push_pusher_dead_letter');
        }
      } catch { /* non-fatal */ }
      await this.syncRoomNamesToNative();
      await this.syncSenderNamesToNative();
    });

    PushNotifications.addListener('registrationError', (error) => {
      console.error('[PushService] Registration error:', error);
    });

    await PushNotifications.register();

    // 5. iOS-only: register a SECOND pusher for VoIP (PushKit). The
    // Swift IOSVoIPPushPlugin starts the PKPushRegistry in load(), so
    // by the time we get here iOS may already have handed us a token —
    // grab it eagerly. Subsequent rotations come through the
    // voipTokenReceived listener.
    if (isIOS) {
      try {
        await IOSVoIPPush.addListener('voipTokenReceived', async ({ token }) => {
          await this.registerVoipPusher(matrixClient, token);
        });
        await IOSVoIPPush.addListener('voipTokenInvalidated', async () => {
          // Best-effort cleanup of the stale VoIP pusher. We don't have
          // the old token in scope, but the Matrix homeserver lists ALL
          // pushers under our user — any fortaios.voip with a key not
          // matching a current token gets dropped on the next
          // registerVoipPusher() pass.
          console.log('[PushService] VoIP token invalidated by iOS');
        });
        const { token } = await IOSVoIPPush.getToken();
        if (token) {
          await this.registerVoipPusher(matrixClient, token);
        }
      } catch (e) {
        console.warn('[PushService] IOSVoIPPush wiring failed:', e);
      }
    }
  }
}

// Extend String prototype locally for hashCode
declare global {
  interface String {
    hashCode(): number;
  }
}

String.prototype.hashCode = function(): number {
  let hash = 0;
  for (let i = 0; i < this.length; i++) {
    hash = ((hash << 5) - hash + this.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
};

export const pushService = new PushService();
