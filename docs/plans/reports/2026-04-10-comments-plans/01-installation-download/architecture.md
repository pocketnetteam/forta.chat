# Архитектура: Установка и скачивание

## Связь с проблемой

Пользователи сообщают: «нажимаю скачать — ничего не происходит», «APK не фурычит», ссылка ведёт на Bastyon, GitHub непонятен, iOS — «непонятно что делать», Google Play предлагает Bastyon.

## Общая схема распространения

Forta Chat распространяется через **три канала**:

| Канал | Платформа | Механизм |
|-------|-----------|----------|
| Web-версия | Браузер | FTP-деплой `dist/` на `forta.chat` |
| APK (Android) | Android 7+ | GitHub Releases (прямая ссылка на `.apk`) |
| Electron | Windows/Mac/Linux | Ручная сборка (`electron-builder`), не автоматизирована в CI |

**В Google Play и App Store приложение НЕ публикуется.**

## Сборка и CI/CD

### Web (`.github/workflows/deploy.yml`)

```
Триггер: push в master
Шаги: npm ci → vite build → minify public JS → FTP upload dist/
```

- `vite.config.ts`: `base: './'` (относительные пути)
- `build.target: 'es2020'`
- Chunk splitting: `matrix`, `vue-core`, `crypto-polyfills`, `virtual-scroller`
- Post-build: `scripts/minify-public-js.mjs` минифицирует скрипты в `dist/js/`

### Android APK (`.github/workflows/android-release.yml`)

```
Триггер: push тегов v*
Шаги: npm ci → vite build → cap sync android → ./gradlew assembleRelease → GitHub Release
```

- `capacitor.config.ts`: `appId: 'com.forta.chat'`, `webDir: 'dist'`, `androidScheme: 'https'`
- Подпись: переменные окружения `RELEASE_STORE_*` (keystore)
- Артефакт: `forta-chat-{version}.apk` → GitHub Releases через `softprops/action-gh-release`

### Electron

- `package.json`: скрипты `electron:build:win`, `electron:build:mac`, `electron:build:linux`
- `electron-builder.json`: nsis/zip (Win), dmg/zip (Mac), AppImage/deb (Linux)
- **CI для Electron НЕ настроен** — только ручная сборка

## PWA

**PWA не реализована:**

- В `index.html` нет `<link rel="manifest">`
- Файл `manifest.json` / `*.webmanifest` в проекте отсутствует
- Нет `beforeinstallprompt` обработчика
- Нет `vite-plugin-pwa` / Workbox
- Service Worker есть (`public/service-worker.js`), но используется только для Electron-транспорта (Tor)

## iOS

- Каталог `ios/` в проекте **не существует**
- В `capacitor.config.ts` нет блока `ios`
- Есть только детектор `isIOS` в `src/shared/lib/platform/index.ts` (задел на будущее)

## Страница скачивания

**Отдельной download page нет:**

- `WelcomePage.vue` — логотип, кнопки «Get Started» / «Create account» → логин/регистрация
- Нет ссылок на APK, GitHub Releases, магазины
- `APP_PUBLIC_URL = "https://forta.chat"` в `src/shared/config/constants.ts` — для invite-ссылок, не для скачивания

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `vite.config.ts` | Конфигурация сборки, полифиллы, chunks |
| `capacitor.config.ts` | Capacitor Android |
| `android/app/build.gradle` | Gradle: SDK versions, signing, Firebase |
| `android/variables.gradle` | `minSdkVersion=24`, `targetSdkVersion=36` |
| `electron/main.cjs` | Electron main process |
| `electron-builder.json` | Конфиг сборки desktop |
| `.github/workflows/deploy.yml` | CI: web деплой |
| `.github/workflows/android-release.yml` | CI: Android APK → GitHub Releases |
| `package.json` | Скрипты build, electron:build |
| `index.html` | Entry point (без manifest) |
