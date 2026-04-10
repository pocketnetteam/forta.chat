# Архитектура: Уведомления (Push)

## Связь с проблемой

Пользователи сообщают: «уведомления не приходят без Google Play Services», «с Google — приходят, без — нет», «в других мессенджерах всё работает».

## Общая схема

```
Matrix Homeserver → Push Gateway → FCM → Android → Нативное уведомление
                   (matrix.pocketnet.app)              ↓
                                                  JS (WebView)
```

## Регистрация Push Token

### Инициализация (JS)

В `stores.ts` после `initMatrix()`:

```
if (isNative) {
  pushService.init(matrixClient)
}
```

### Получение FCM токена

`push-service.ts`:
```
PushNotifications.register()  // @capacitor/push-notifications
→ listener 'registration' → { value: token }
→ registerPusher(matrixClient, token)
→ syncRoomNamesToNative()
→ syncSenderNamesToNative()
```

### Регистрация Matrix Pusher

```typescript
matrixClient.setPusher({
  pushkey: token,           // FCM token
  kind: 'http',
  app_id: 'fortaandroid',
  app_display_name: 'Forta Chat',
  device_display_name: 'Android',
  lang: 'en',
  data: {
    url: 'https://matrix.pocketnet.app/_matrix/push/v1/notify'
  }
});
```

После регистрации — очистка устаревших pushers с тем же `app_id` и другим `pushkey`.

### Обновление токена (Android)

`FortaFirebaseMessagingService.onNewToken()`:
- Сохраняет в `SharedPreferences("fcm_token")`
- Повторная регистрация pusher — **только при следующем запуске JS** (нет нативного вызова к Matrix)

## Обработка Push на Android

### Сервис

`FortaFirebaseMessagingService` в `AndroidManifest.xml`:
```xml
<service android:name=".FortaFirebaseMessagingService" android:exported="false">
  <intent-filter>
    <action android:name="com.google.firebase.MESSAGING_EVENT" />
  </intent-filter>
</service>
```

### Общий поток

```
onMessageReceived(message):
  data = message.data  // data-only payload (НЕ notification)
  roomId = data["room_id"]
  
  if msg_type == "m.call.invite":
    → showCallNotification (IncomingCallActivity, TelecomManager)
  else if msg_type == "m.call.hangup" / "m.call.reject":
    → closeIncomingCallActivity
  else:
    → showMessageNotification(roomId, eventId, title, body)
    
  forwardToJs(data)  // если WebView жив
```

### Формирование уведомления

- Заголовок: `sender_display_name` из push ИЛИ кэш `SharedPreferences` ИЛИ `room_alias` ИЛИ roomId
- Тело: превью по `content_msgtype` (фото/видео/файл/голосовое/...)
- PendingIntent: MainActivity с extras `push_room_id`, `push_event_id`

### Каналы уведомлений

| Канал | Назначение |
|-------|------------|
| `messages` | Обычные сообщения |
| `calls` | Звонки (высокий приоритет) |

## Обработка Push в JS

### Foreground

```
pushService: listener 'pushReceived':
  if document.hidden == false && activeRoom == roomId:
    → PushData.cancelNotification({ roomId })  // отменить если чат открыт
    return
    
  optimisticRoomUpdate(roomId, preview, timestamp, sender)
    → RoomRepository.optimisticUpdateFromPush:
      → unreadCount += 1 (монотонно)
      → обновление превью и timestamp
      
  tryDecryptAndReplace():
    → fetch события → расшифровка → PushData.replaceNotificationContent
```

### Background / App Killed

- `forwardToJs` не работает (WebView не загружен)
- Нативное уведомление остаётся как есть
- При запуске: `PushDataPlugin.load()` → буферизация intent → `getPendingIntent`

### Навигация по тапу

```
PendingIntent → MainActivity (push_room_id, push_event_id)
  → PushDataPlugin: bufferPushIntent → pushOpenRoom event
  → push-service.ts: emit 'push:openRoom'
  → App.vue: processPushOpenRoom → router.push(ChatPage) + setActiveRoom
```

## Без Google Play Services

**В текущем коде НЕ реализована поддержка устройств без GMS:**

- Единственный канал: `FirebaseMessagingService` (`firebase-messaging:25.0.1`)
- Нет ветки для MicroG, HMS, Unified Push, WebSocket fallback
- В `build.gradle`: `google-services.json` опционален, но без него **push не работают**

```groovy
// android/app/build.gradle
try {
    def servicesJSON = file('google-services.json')
    if (servicesJSON.text) {
        apply plugin: 'com.google.gms.google-services'
    }
} catch(Exception e) {
    logger.info("google-services.json not found... Push Notifications won't work")
}
```

## Настройки уведомлений

В `SettingsPage.vue` — **заглушка (placeholder)**:

```html
<!-- Notifications (placeholder) -->
<span>{{ t("settings.notifications") }}</span>
<span>{{ t("settings.enabled") }}</span>
```

**Нет переключателей, нет связи с Matrix push rules, нет per-room настроек.**

## In-App: Badge и Unread

### Системный badge (иконка приложения)

**НЕ реализован** — нет Capacitor Badge API.

### UI badge в списке чатов

- `unreadCount` на комнате → отображение `99+` в `ContactList.vue`
- Обновление из push: `optimisticUpdateFromPush` → `unreadCount + 1`
- Обновление из sync: `EventWriter` → `RoomRepository`

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `src/shared/lib/push/push-service.ts` | FCM registration, Matrix pusher, JS handling |
| `src/shared/lib/push/push-data-plugin.ts` | Capacitor PushData bridge |
| `android/.../FortaFirebaseMessagingService.kt` | Приём FCM, нативные уведомления |
| `android/.../plugins/push/PushDataPlugin.kt` | JS ↔ Native мост для push data |
| `android/app/src/main/AndroidManifest.xml` | Регистрация сервисов |
| `android/app/build.gradle` | Firebase зависимости |
| `src/entities/auth/model/stores.ts` | Инициализация push + call handler |
| `src/app/App.vue` | processPushOpenRoom navigation |
| `src/shared/lib/local-db/room-repository.ts` | optimisticUpdateFromPush |
| `src/pages/settings/SettingsPage.vue` | Placeholder секция уведомлений |
