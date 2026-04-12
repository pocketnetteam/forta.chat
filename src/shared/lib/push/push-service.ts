import { PushNotifications } from '@capacitor/push-notifications';
import { LocalNotifications } from '@capacitor/local-notifications';
import { isNative } from '@/shared/lib/platform';
import { PushData, type PushPayload } from './push-data-plugin';
import { tRaw } from '@/shared/lib/i18n';

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
  private optimisticRoomUpdate: ((roomId: string, preview: string, timestamp: number, senderId?: string) => Promise<boolean>) | null = null;
  /** Check if a room should be hidden (e.g. broadcast/stream rooms) — suppress push. */
  private isRoomHidden: ((roomId: string) => boolean) | null = null;

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

  setRoomHiddenChecker(checker: (roomId: string) => boolean) {
    this.isRoomHidden = checker;
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

  private async registerPusher(matrixClient: any, token: string): Promise<void> {
    try {
      await matrixClient.setPusher({
        pushkey: token,
        kind: 'http',
        app_id: 'fortaandroid',
        app_display_name: 'Forta Chat',
        device_display_name: 'Android',
        lang: 'en',
        data: {
          url: 'https://matrix.pocketnet.app/_matrix/push/v1/notify',
        },
      });
      // pusher registered

      try {
        const { pushers } = await matrixClient.getPushers();
        for (const p of pushers) {
          if (p.app_id === 'fortaandroid' && p.pushkey !== token) {
            // remove stale pusher
            await matrixClient.setPusher({ ...p, kind: null });
          }
        }
      } catch (pe) {
        console.warn('[PushService] Could not clean stale pushers:', pe);
      }
    } catch (e) {
      console.error('[PushService] Failed to register pusher:', e);
    }
  }

  /**
   * Wait for the event to arrive via sync and be decrypted by the SDK,
   * then replace the native notification with the decrypted content.
   */
  private async tryDecryptAndReplace(data: PushPayload): Promise<void> {
    const { room_id: roomId, event_id: eventId } = data;
    if (!roomId || !this.matrixClient) return;

    try {
      // 1. Already in timeline?
      const existing = this.findDecryptedEvent(roomId, eventId);
      if (existing) {
        await this.replaceNotification(roomId, eventId, existing);
        return;
      }

      // 2. FAST PATH: targeted fetch
      if (eventId) {
        const fetched = await this.tryTargetedFetch(roomId, eventId);
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

  /** Extract message from a directly-fetched event */
  private async tryTargetedFetch(
    roomId: string,
    eventId: string,
  ): Promise<{ senderName: string; body: string } | null> {
    try {
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

    // Suppress push for hidden rooms (broadcast/stream groups)
    if (this.isRoomHidden?.(roomId)) {
      PushData.cancelNotification({ roomId }).catch(() => {});
      return;
    }

    // Handle calls
    if (data.msg_type === 'm.call.invite') {
      this.onCallPush?.({
        callId: data.event_id || '',
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
      this.optimisticRoomUpdate(roomId, preview, ts, data.sender).catch(() => {});
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

    // Listen for notification tap (from native intent)
    PushData.addListener('pushOpenRoom', (data) => {
      // push tap → open room
      window.dispatchEvent(new CustomEvent('push:openRoom', {
        detail: { roomId: data.roomId, eventId: data.eventId },
      }));
    });

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

    // 4. Register for FCM
    await PushNotifications.removeAllListeners();

    PushNotifications.addListener('registration', async ({ value: token }) => {
      // FCM token received
      this.fcmToken = token;
      await this.registerPusher(matrixClient, token);
      await this.syncRoomNamesToNative();
      await this.syncSenderNamesToNative();
    });

    PushNotifications.addListener('registrationError', (error) => {
      console.error('[PushService] Registration error:', error);
    });

    await PushNotifications.register();
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
