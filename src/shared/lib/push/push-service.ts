import { PushNotifications } from '@capacitor/push-notifications';
import { LocalNotifications } from '@capacitor/local-notifications';
import { isNative } from '@/shared/lib/platform';

class PushService {
  private fcmToken: string | null = null;
  private onCallPush: ((data: { callId: string; callerName: string; roomId: string; hasVideo: boolean }) => void) | null = null;
  private fetchAndDecrypt: ((roomId: string, eventId: string) => Promise<{ senderName: string; body: string } | null>) | null = null;

  setCallHandler(handler: typeof this.onCallPush) {
    this.onCallPush = handler;
  }

  setDecryptHandler(handler: typeof this.fetchAndDecrypt) {
    this.fetchAndDecrypt = handler;
  }

  async init(matrixClient: any): Promise<void> {
    if (!isNative) return;

    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted') {
      console.warn('[PushService] Push permission denied');
      return;
    }

    await LocalNotifications.requestPermissions();

    await LocalNotifications.createChannel({
      id: 'messages',
      name: 'Messages',
      description: 'Chat message notifications',
      importance: 4,
      sound: 'default',
      vibration: true,
    });

    await LocalNotifications.createChannel({
      id: 'calls',
      name: 'Calls',
      description: 'Incoming call notifications',
      importance: 5,
      sound: 'ringtone',
      vibration: true,
    });

    await PushNotifications.register();

    PushNotifications.addListener('registration', async ({ value: token }) => {
      console.log('[PushService] FCM token:', token.substring(0, 20) + '...');
      this.fcmToken = token;

      try {
        await matrixClient.setPusher({
          pushkey: token,
          kind: 'http',
          app_id: 'com.forta.chat',
          app_display_name: 'Forta Chat',
          device_display_name: 'Android',
          lang: 'en',
          data: {
            url: 'https://push.bastyon.com/_matrix/push/v1/notify',
            format: 'event_id_only',
          },
        });
        console.log('[PushService] Matrix pusher registered');
      } catch (e) {
        console.error('[PushService] Failed to register pusher:', e);
      }
    });

    PushNotifications.addListener('registrationError', (error) => {
      console.error('[PushService] Registration error:', error);
    });

    PushNotifications.addListener('pushNotificationReceived', async (notification) => {
      const data = notification.data || {};

      if (data.type === 'call') {
        this.onCallPush?.({
          callId: data.call_id || data.event_id,
          callerName: data.caller_name || 'Unknown',
          roomId: data.room_id,
          hasVideo: data.has_video === 'true',
        });
        return;
      }

      const { event_id, room_id } = data;
      if (!event_id || !room_id) return;

      try {
        const decrypted = await this.fetchAndDecrypt?.(room_id, event_id);
        if (!decrypted) return;

        await LocalNotifications.schedule({
          notifications: [{
            id: Math.abs(hashString(event_id)),
            title: decrypted.senderName,
            body: decrypted.body,
            channelId: 'messages',
            extra: { room_id, event_id },
          }],
        });
      } catch (e) {
        console.error('[PushService] Failed to process push:', e);
      }
    });

    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const { room_id } = action.notification.data || {};
      if (room_id) {
        window.dispatchEvent(new CustomEvent('push:openRoom', { detail: { roomId: room_id } }));
      }
    });

    LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      const { room_id } = action.notification.extra || {};
      if (room_id) {
        window.dispatchEvent(new CustomEvent('push:openRoom', { detail: { roomId: room_id } }));
      }
    });
  }
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

export const pushService = new PushService();
