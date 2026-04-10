# Архитектура: Иконка, доступ и запуск

## Связь с проблемой

Пользователи сообщают: «как вывести иконку на экран телефона», «установил, но как теперь открыть — непонятно».

## Способы доступа к приложению

### 1. Web-версия (браузер)

- URL: `https://forta.chat`
- Открывается в любом браузере
- **НЕ является PWA** — нет `manifest.json`, нет install prompt
- Нет подсказки «Добавить на главный экран»
- Иконка: только favicon в `index.html` (`forta-icon.png`)

### 2. Android APK (Capacitor)

- Устанавливается из APK файла (GitHub Releases)
- После установки: иконка на лаунчере (стандартное поведение Android)
- `appId: 'com.forta.chat'`
- Имя: `'Forta Chat'`

### 3. Electron Desktop

- Устанавливается через installer (nsis/dmg/AppImage)
- Иконка: `public/forta-icon.png` (в `electron-builder.json`)
- **Нет автоматических релизов** — только ручная сборка

## PWA и «Добавить на главный экран»

### Текущее состояние

**PWA не реализована:**

- `index.html` — нет `<link rel="manifest">`
- `manifest.json` / `*.webmanifest` — отсутствуют
- `beforeinstallprompt` — нет обработчика
- `vite-plugin-pwa` — не подключён

### Service Worker

`public/service-worker.js` — существует, но:
- Предназначен для **Electron** (Tor-транспорт)
- Регистрируется ТОЛЬКО при `isElectron` (`src/shared/lib/transport/init-transport.ts`)
- **НЕ регистрируется** на обычном вебе и в Capacitor

### Последствия

- В браузере **нельзя** нажать «Добавить на главный экран» (нет PWA criteria)
- Нет офлайн-кэширования через SW
- Нет push-уведомлений в вебе (только нативный FCM)

## Android: иконка и запуск

### Манифест

`AndroidManifest.xml`:
```xml
<activity android:name=".MainActivity"
          android:exported="true"
          android:launchMode="singleTask">
  <intent-filter>
    <action android:name="android.intent.action.MAIN" />
    <category android:name="android.intent.category.LAUNCHER" />
  </intent-filter>
</activity>
```

### Splash Screen

```groovy
// build.gradle
implementation 'androidx.core:core-splashscreen:1.0.1'
```

В `styles.xml`: тема `Theme.SplashScreen` — Android SplashScreen API (не Capacitor Splash plugin).

### Иконка приложения

Стандартная Capacitor/Android структура:
- `android/app/src/main/res/mipmap-*/` — иконки разных размеров
- Устанавливается автоматически при `cap sync`

## Electron: иконка и запуск

### Конфиг

`electron-builder.json`:
```json
{
  "icon": "public/forta-icon.png",
  "win": { "target": ["nsis", "zip"] },
  "mac": { "target": ["dmg", "zip"] },
  "linux": { "target": ["AppImage", "deb"] }
}
```

### Поведение при запуске

`electron/main.cjs`:
- Кастомная схема `app://chat/`
- `BrowserWindow` с заданными размерами
- В dev: URL Vite dev server
- В prod: `app://chat/index.html`

## Проблема «установил, но как открыть»

### Веб

- Пользователь открыл `forta.chat` в браузере
- Нет PWA → нельзя «установить» → нет иконки на home screen
- Единственный вариант: создать ярлык вручную в браузере

### APK

- APK скачивается из GitHub Releases
- Установка требует включения «Неизвестные источники»
- После установки: стандартная иконка на лаунчере
- **Нет in-app объяснения** процесса установки APK

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `index.html` | Favicon, meta tags (нет manifest) |
| `public/forta-icon.png` | Иконка приложения |
| `capacitor.config.ts` | appId, appName |
| `android/app/src/main/AndroidManifest.xml` | Launcher activity |
| `electron-builder.json` | Desktop icon, targets |
| `electron/main.cjs` | Desktop window setup |
| `public/service-worker.js` | SW (только для Electron) |
| `src/shared/lib/transport/init-transport.ts` | Регистрация SW (Electron only) |
