# Архитектура: Совместимость с устройствами

## Связь с проблемой

Пользователи сообщают: «не запускается на Honor 10X Lite», «Android 16 — не работают чаты и профиль», «ошибка на Cubot P80».

## Android SDK версии

`android/variables.gradle`:

```groovy
minSdkVersion = 24        // Android 7.0 (Nougat)
compileSdkVersion = 36    // Android 16
targetSdkVersion = 36     // Android 16
```

### Покрытие версий Android

| Android | API | Поддержка |
|---------|-----|-----------|
| 7.0–7.1 | 24–25 | Минимальная |
| 8.0–8.1 | 26–27 | Да |
| 9–12 | 28–31 | Да |
| 13 | 33 | Да |
| 14 | 34 | Да |
| 15 | 35 | Да |
| 16 | 36 | Target (может иметь breaking changes) |

## Архитектуры процессоров (ABI)

**В `build.gradle` НЕ указаны `ndk.abiFilters` / `splits`.**

Значит APK содержит нативные библиотеки **всех ABI** из зависимостей:
- `io.github.webrtc-sdk:android` — armeabi-v7a, arm64-v8a, x86, x86_64
- `firebase-messaging` — универсальный
- Другие native libs

Размер APK увеличен, но совместимость максимальная.

## WebView зависимость

Capacitor-приложение работает внутри **Android WebView** (System WebView или Chrome-based). Критические зависимости:

- ES2020 target (`vite.config.ts: build.target: "es2020"`)
- `globalThis` (подменяется в Vite `define`)
- `crypto.subtle` для шифрования
- IndexedDB для Dexie и Matrix SDK
- `visualViewport` API
- WebRTC (`RTCPeerConnection`) — проксируется на натив через `NativeWebRTC`

### Потенциальные проблемы

1. **Старый WebView** (не обновляется на некоторых устройствах) → отсутствие ES2020 фич
2. **Huawei без GMS** → WebView может быть устаревшим
3. **Custom ROM** → нестандартный WebView

## Polyfills

`vite.config.ts`:
- `buffer` → `buffer/`
- `stream` → `stream-browserify`
- `process` → подмена через `define`
- `global` → `globalThis`
- Chunk `crypto-polyfills`: `buffer`, `stream-browserify`, `pbkdf2`, `create-hash`, `bn.js`

**НЕ используется** `@vitejs/plugin-legacy` (нет транспиляции для старых браузеров).

## Потенциальные устройственные проблемы

### Honor 10X Lite

- Процессор: Kirin 710A (arm64-v8a)
- Android: 10, EMUI 10.1
- Поддержка GMS: да (не Huawei AppGallery-only)
- Возможная проблема: WebView версия, memory constraints

### Android 16 (API 36)

- `targetSdkVersion = 36` — приложение декларирует совместимость
- Но API 36 может вводить новые ограничения (scoped storage, permissions, foreground services)
- Возможные breaking changes в Telecom API, Notification channels

### Cubot P80

- Бюджетное устройство, MediaTek процессор
- Возможные проблемы: нестандартный WebView, агрессивный battery optimization

## Android Native компоненты

### Permissions (AndroidManifest.xml)

```xml
INTERNET, ACCESS_NETWORK_STATE
RECORD_AUDIO, CAMERA, MODIFY_AUDIO_SETTINGS, BLUETOOTH_CONNECT
MANAGE_OWN_CALLS, USE_FULL_SCREEN_INTENT
FOREGROUND_SERVICE, FOREGROUND_SERVICE_PHONE_CALL, FOREGROUND_SERVICE_MEDIA_PROJECTION
POST_NOTIFICATIONS, READ_MEDIA_IMAGES, READ_MEDIA_VIDEO, READ_MEDIA_AUDIO
WRITE_EXTERNAL_STORAGE (legacy), REQUEST_INSTALL_PACKAGES
```

### Native плагины

| Плагин | Назначение | Файл |
|--------|------------|------|
| `NativeWebRTC` | WebRTC через нативный стек | `WebRTCPlugin.kt` |
| `NativeCall` | AudioRouter, permissions | `CallPlugin.kt` |
| `PushData` | Push data forwarding | `PushDataPlugin.kt` |
| `AppLocale` | Синхронизация языка | Capacitor plugin |

### Gradle зависимости

```groovy
implementation 'com.google.firebase:firebase-messaging:25.0.1'
implementation 'io.github.nickolay-ponomarenko:nickolay-nickolay-nickolay-nickolay-nickolay:1.0.5' // Tor
implementation 'io.github.nickolay-nickolay-nickolay-nickolay-nickolay:nickolay-nickolay:1.0.5'
implementation 'io.github.nickolay-nickolay-nickolay-nickolay:nickolay-nickolay-nickolay:1.0.5'
implementation 'io.github.nickolay-ponomarenko:nickolay:1.0.5'
implementation 'io.github.nickolay-nickolay:nickolay:1.0.5'
implementation 'io.github.webrtc-sdk:android:125.6422.07'
implementation 'androidx.core:core-splashscreen:1.0.1'
```

## iOS (отсутствует)

- Каталог `ios/` не создан
- В `capacitor.config.ts` нет `ios` блока
- Только детектор `isIOS` в `src/shared/lib/platform/index.ts`

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `android/variables.gradle` | SDK версии |
| `android/app/build.gradle` | Зависимости, signing, Firebase |
| `android/app/src/main/AndroidManifest.xml` | Permissions, services |
| `vite.config.ts` | Build target, polyfills |
| `capacitor.config.ts` | App config |
| `src/shared/lib/platform/index.ts` | Детекция платформы |
| `android/app/src/main/java/com/forta/chat/MainActivity.kt` | Edge-to-edge, keyboard |
