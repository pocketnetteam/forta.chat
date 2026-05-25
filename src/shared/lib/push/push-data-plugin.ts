import { registerPlugin } from '@capacitor/core';
import type { Plugin, PluginListenerHandle } from '@capacitor/core';

export interface PushPayload {
  room_id: string;
  event_id?: string;
  msg_type?: string;
  content_msgtype?: string;
  sender_display_name?: string;
  room_name?: string;
  sender?: string;
  unread?: string;
  missed_calls?: string;
  /** Stable Matrix m.call.* call_id. Persists across invite retries (each
   *  retry has a new event_id). Prefer this over event_id for call
   *  correlation. Session 41. */
  call_id?: string;
}

interface PushDataPlugin extends Plugin {
  cacheRoomName(options: { roomId: string; name: string }): Promise<void>;
  cacheRoomNames(options: { rooms: Record<string, string> }): Promise<void>;
  cacheSenderNames(options: { senders: Record<string, string> }): Promise<void>;
  cancelNotification(options: { roomId: string }): Promise<void>;
  /** WEE-44 / forta-bugs#764: clear all message-channel notifications so the
   *  launcher icon badge resets after the user has demonstrably seen unread
   *  state (e.g. mark-all-read, app resume on the chat list). */
  cancelAllMessageNotifications(): Promise<void>;
  /** Replace native notification content (keeps native PendingIntent for tap handling) */
  replaceNotificationContent(options: { roomId: string; eventId?: string; title: string; body: string }): Promise<void>;
  getPendingIntent(): Promise<{ roomId?: string; eventId?: string }>;
  /** WEE-44 / forta-bugs#732, #766: returns Build.MANUFACTURER + MODEL so JS
   *  can show a one-time hint pointing the user at battery optimization
   *  settings for known-hostile vendors (Samsung, HONOR/Huawei, Xiaomi, OPPO,
   *  OnePlus). Empty strings on non-Android or when the field is unavailable. */
  getDeviceManufacturer(): Promise<{ manufacturer: string; model: string; sdk: number }>;
  addListener(event: 'pushReceived', handler: (data: PushPayload) => void): Promise<PluginListenerHandle>;
  addListener(event: 'pushOpenRoom', handler: (data: { roomId: string; eventId?: string }) => void): Promise<PluginListenerHandle>;
}

export const PushData = registerPlugin<PushDataPlugin>('PushData');
