# Архитектура: Звонки (WebRTC)

## Связь с проблемой

Пользователи сообщают: звонок идёт но принять нельзя (бесконечное соединение), связь односторонняя, не работает аудио, работает только по громкой связи, если приложение закрыто — звонок не приходит, случайно запретил звонки.

## Общая архитектура

```
┌──────────────────────────────────────────────────┐
│                  call-service.ts                  │
│  (инициация, ответ, события, нативный мост)      │
├─────────────┬──────────────┬─────────────────────┤
│ MatrixCall  │  CallStore   │ NativeWebRTC        │
│ (SDK)       │  (Pinia)     │ (Capacitor plugin)  │
├─────────────┼──────────────┼─────────────────────┤
│ matrix-js-  │ call-store   │ WebRTCPlugin.kt     │
│ sdk-bastyon │ .ts          │ CallPlugin.kt       │
│             │              │ CallActivity.kt     │
│             │              │ IncomingCallActivity │
└─────────────┴──────────────┴─────────────────────┘
```

## Исходящий звонок

### Инициация (`call-service.ts`)

```
startCall(roomId, type):
  1. Проверки:
     - callStore.isInCall → abort
     - checkOtherTabHasCall (BroadcastChannel) → abort
     
  2. createNewMatrixCall(client, roomId) — SDK
     → null если WebRTC недоступен
     
  3. callStore.setActiveCall(callInfo)
     callStore.setMatrixCall(call)
     wireCallEvents(call, "outgoing")
     
  4. playDialtone()
  
  5. (натив) nativeCallBridge.reportOutgoingCall({
       callId, callerName, hasVideo
     })
     NativeWebRTC.launchCallUI({
       callerName, callType, callId, direction: "outgoing"
     })
     
  6. hintStoredDevices(client) — подсказка SDK сохранённых устройств
  
  7. call.placeVideoCall() или call.placeVoiceCall()
```

## Входящий звонок

### Получение через Matrix SDK

```
matrix-client.ts:
  client.on("Call.incoming", (call) => onIncomingCall(call))

stores.ts:
  matrixService.setHandlers({ onIncomingCall: callService.handleIncomingCall })
```

### Обработка

```
handleIncomingCall(matrixCall):
  1. Если уже в звонке → matrixCall.reject()
  2. Если другая вкладка → matrixCall.reject()
  
  3. wireCallEvents(matrixCall, "incoming")
  
  4. (натив) nativeCallBridge.reportIncomingCall({
       callId, callerName, roomId, hasVideo
     })
     → Android: IncomingCallActivity / TelecomManager
     
  5. (веб) playRingtone()
  
  6. Таймаут 30 секунд → rejectCall() если не ответили
```

### Ответ

```
answerCall():
  call.answer(true, isVideo)
  (натив) NativeWebRTC.launchCallUI(... direction: "incoming")
```

### Входящий звонок из Push (фон/killed)

```
FortaFirebaseMessagingService.onMessageReceived():
  msg_type === "m.call.invite":
    → showCallNotification (IncomingCallActivity)
    → TelecomManager.addNewIncomingCall (fallback: fullScreenIntent)
    → forwardToJs(data)

push-service.ts (JS):
  onCallPush → nativeCallBridge.reportIncomingCall(data)
```

## WebRTC: ICE / STUN / TURN

### Конфигурация клиента

```typescript
// matrix-client.ts
{
  iceCandidatePoolSize: 20,
  fallbackICEServerAllowed: true,
  disableVoip: false
}
```

### Получение ICE серверов

- **Конкретные STUN/TURN URL в коде приложения НЕ захардкожены**
- Формируются через **matrix-js-sdk-bastyon** (ответ homeserver `/voip/turnServer` или встроенные дефолты SDK)
- `fallbackICEServerAllowed: true` — SDK может использовать встроенные STUN

### Натив (Android)

`RTCPeerConnectionProxy` передаёт `config.iceServers` в `NativeWebRTC.createPeerConnection()`:

```typescript
// rtc-peer-connection-proxy.ts
const iceServers = (config?.iceServers ?? []).map(s => ({
  urls: s.urls,
  username: s.username,
  credential: s.credential
}));
await NativeWebRTC.createPeerConnection({ peerId, iceServers });
```

Kotlin (`WebRTCPlugin.kt`): парсинг в `PeerConnection.IceServer`.

### Диагностика

При `iceConnectionState === "failed"|"disconnected"` → предупреждение в лог.

## Сигнализация

- SDP/ICE обмен через **Matrix VoIP events** (`m.call.invite`, `m.call.answer`, `m.call.candidates`, `m.call.hangup`)
- Полностью внутри SDK — приложение не отправляет VoIP events вручную
- `m.call.hangup` обрабатывается в таймлайне для системных сообщений

## Аудио / Видео потоки

### Синхронизация с UI

```typescript
// call-service.ts
updateFeeds(call):
  callStore.setLocalStream(call.localUsermediaStream)
  callStore.setRemoteStream(call.remoteUsermediaStream)
  callStore.setLocalScreenStream(call.localScreensharingStream)
  callStore.setRemoteScreenStream(call.remoteScreensharingStream)
```

### Воспроизведение

`CallWindow.vue`: скрытый `<video>` с `srcObject = remoteStream`; опционально `setSinkId` для выбора устройства вывода.

### Переключение устройств mid-call

```
getUserMedia({ exact: deviceId })
→ RTCRtpSender.replaceTrack()
→ mediaHandler.restoreMediaSettings
```

### Громкая связь

| Платформа | Механизм |
|-----------|----------|
| Web | `HTMLMediaElement.setSinkId(deviceId)` |
| Android | `AudioRouter`: earpiece, speaker, bluetooth, wired_headset |

Android (`CallActivity.kt`): кнопка маршрута аудио + bottom sheet с выбором устройства.

**Проблема «работает только по громкой связи»:** вероятно, `AudioRouter` по умолчанию выбирает speaker вместо earpiece, или переключение не срабатывает.

## Фоновые звонки (Android)

### Нативные компоненты

| Компонент | Назначение |
|-----------|------------|
| `CallConnectionService` | Android Telecom API (BIND_TELECOM_CONNECTION_SERVICE) |
| `CallForegroundService` | Foreground service (foregroundServiceType="phoneCall") |
| `IncomingCallActivity` | Экран входящего звонка (fullscreen) |
| `CallActivity` | Экран активного звонка |
| `FortaFirebaseMessagingService` | Обработка push → показ звонка |

### Мост JS ↔ Натив

`nativeCallBridge.wire(callService)` после инициализации Matrix:
- Ответ/отклонение/завершение с системного UI → `answerCall`/`rejectCall`/`hangup`
- Events: `onNativeHangup`, `onNativeVideoToggle`

### Проблема «звонок не приходит если приложение закрыто»

Цепочка: FCM → `FortaFirebaseMessagingService.onMessageReceived` → `showCallNotification`

Возможные причины сбоя:
1. FCM не доставил push (нет Google Play Services)
2. Battery optimization убивает сервис
3. `pluginInstance === null` (WebView не загружен) → JS-часть не получает данные
4. `TelecomManager` не разрешён

## Разрешения (Android)

```xml
RECORD_AUDIO
CAMERA
MODIFY_AUDIO_SETTINGS
BLUETOOTH_CONNECT
MANAGE_OWN_CALLS
USE_FULL_SCREEN_INTENT
FOREGROUND_SERVICE
FOREGROUND_SERVICE_PHONE_CALL
FOREGROUND_SERVICE_MEDIA_PROJECTION
POST_NOTIFICATIONS
```

При `nativeCallBridge.wire()` запрашивается `NativeCall.requestAudioPermission()`.

**Проблема «случайно запретил звонки»:** скорее всего отклонил RECORD_AUDIO/CAMERA на системном уровне. В приложении нет UI для повторного запроса (только стандартный Android settings).

## Блокировка одного звонка на вкладку

`call-tab-lock.ts`: `BroadcastChannel("bastyon_call_lock")` — только одна вкладка/окно может вести звонок.

## Обработка ошибок

```
CallEvent.Error:
  → log(code, message)
  → stopAllSounds()
  → unwireCallEvents(call)
  → (натив) reportCallEnded + dismissCallUI
  → callStore.updateStatus(CallStatus.failed)
  → scheduleClearCall(2000)
```

## UI компоненты

| Компонент | Назначение |
|-----------|------------|
| `CallWindow.vue` | Основное окно (тайлы, remote audio, PiP) |
| `CallControls.vue` | Мьют, камера, screen share, устройства |
| `VideoTile.vue` | Плитка видео |
| `CallStatusBar.vue` | Компактная полоса при минимизации |
| `IncomingCallModal.vue` | Входящий (только веб, не натив) |
| `CallEventCard.vue` | Карточка звонка в ленте |

Глобальный монтаж в `App.vue`: `IncomingCallModal`, `CallWindow`, `CallStatusBar`.

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `src/features/video-calls/model/call-service.ts` | Основная логика звонков |
| `src/entities/call/model/call-store.ts` | Pinia store: состояние, потоки |
| `src/entities/matrix/model/matrix-client.ts` | Call.incoming, ICE config |
| `src/shared/lib/native-webrtc/rtc-peer-connection-proxy.ts` | WebRTC proxy для нативного стека |
| `src/shared/lib/native-calls/native-call-bridge.ts` | JS ↔ Android мост |
| `src/features/video-calls/model/call-tab-lock.ts` | Блокировка одного звонка |
| `android/.../WebRTCPlugin.kt` | Native WebRTC (PeerConnection) |
| `android/.../CallPlugin.kt` | Native Call (AudioRouter, permissions) |
| `android/.../CallActivity.kt` | Экран активного звонка |
| `android/.../IncomingCallActivity.kt` | Экран входящего |
| `android/.../CallConnectionService.kt` | Telecom API |
| `android/.../CallForegroundService.kt` | Foreground service |
| `android/.../FortaFirebaseMessagingService.kt` | Push → call notification |
