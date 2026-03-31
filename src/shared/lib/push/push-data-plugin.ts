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
}

interface PushDataPlugin extends Plugin {
  cacheRoomName(options: { roomId: string; name: string }): Promise<void>;
  cacheRoomNames(options: { rooms: Record<string, string> }): Promise<void>;
  cacheSenderNames(options: { senders: Record<string, string> }): Promise<void>;
  cancelNotification(options: { roomId: string }): Promise<void>;
  /** Replace native notification content (keeps native PendingIntent for tap handling) */
  replaceNotificationContent(options: { roomId: string; eventId?: string; title: string; body: string }): Promise<void>;
  getPendingIntent(): Promise<{ roomId?: string; eventId?: string }>;
  addListener(event: 'pushReceived', handler: (data: PushPayload) => void): Promise<PluginListenerHandle>;
  addListener(event: 'pushOpenRoom', handler: (data: { roomId: string; eventId?: string }) => void): Promise<PluginListenerHandle>;
}

export const PushData = registerPlugin<PushDataPlugin>('PushData');
