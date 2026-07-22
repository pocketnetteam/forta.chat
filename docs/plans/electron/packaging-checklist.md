# Packaging checklist — Forta Chat Desktop

Использовать перед каждым публичным релизом. Детали фаз — в [electron-desktop-integration-plan.md](./electron-desktop-integration-plan.md).

## Pre-build

- [ ] Версия в `package.json` совпадает с тегом (`1.x.y`)
- [ ] `appId` в `electron-builder.json` не менялся (`com.forta.chat`)
- [ ] Иконки: Win `.ico`, mac `.icns`, Linux PNG на месте
- [ ] Tor binaries / extraResources на месте (если вынесены из asar)
- [ ] Changelog / release notes готовы

## Build

```bash
npm ci
npm run test
npm run electron:build:win     # на Windows или windows-latest
npm run electron:build:mac     # только macOS
npm run electron:build:linux   # Ubuntu runner / Linux host
```

- [ ] Артефакты появились в `release/`
- [ ] Имена файлов содержат version + os + arch
- [ ] Рядом есть `latest.yml` / `latest-mac.yml` / `latest-linux.yml` (если включён updater)

## Signing (release)

Детали env и publish: [signing-and-updates.md](./signing-and-updates.md).

### Windows

- [ ] `CSC_LINK` / `CSC_KEY_PASSWORD` (или Azure Trusted Signing env)
- [ ] NSIS installer подписан (свойства файла → Digital Signatures)
- [ ] SmartScreen: ожидать warning на новых OV-сертах
- [ ] Release CI: `-c.forceCodeSigning=true` (в репо по умолчанию `false`)

### macOS

- [ ] Developer ID Application в CI / keychain
- [ ] Notarize: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
- [ ] `spctl --assess --type execute` / открытие без Gatekeeper bypass
- [ ] Entitlements позволяют Tor spawn + camera/mic

### Linux

- [ ] AppImage запускается на Ubuntu 22.04+
- [ ] `.deb` ставится и удаляется чисто
- [ ] Опционально: GPG-подпись пакета

## Smoke после установки

- [ ] Первый запуск, окно без белого flash
- [ ] TitleBar / traffic lights (mac)
- [ ] Логин → синк комнат
- [ ] Сообщение + файл (save dialog на Electron)
- [ ] Входящее/исходящее уведомление
- [ ] Звонок: mic/cam permission prompt
- [ ] Tor: Never → Auto → Always, статус в TitleBar
- [ ] Single instance: второй запуск фокусирует первое окно
- [ ] Deep link (`forta://room/…` / `forta://join?room=` — Phase 2)
- [ ] Close → tray / Quit из tray (Phase 2)
- [ ] Badge unread на taskbar/dock (Phase 2)
- [ ] Notification click → open room (Phase 2)
- [ ] Update с предыдущей версии (если фаза 3+)

## Publish

- [ ] Tag `v*` с версией = `package.json` (CI Desktop Release)
- [ ] Upload на GitHub Release (`electron-builder --publish always` + `GH_TOKEN`) — или артефакты из Actions
- [ ] Проверка download URL из `latest*.yml`
- [ ] Пост в канал релиза + известные ограничения (unsigned / SmartScreen)
- [ ] Smoke: vN → vN+1 auto-update (Settings → Desktop → Updates)

CI details: [ci-desktop.md](./ci-desktop.md).
