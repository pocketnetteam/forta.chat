# Локальная сборка iOS

> Зеркало `docs/android-local-build.md` для iOS-порта. Покрывает локальные dev-сборки (симулятор / реальное устройство), архив для TestFlight / App Store, и одноразовые Xcode-шаги — особенно для capability "Associated Domains" под Universal Links.

## Пререквизиты

| Требование | Значение |
|---|---|
| Хост | **macOS 14+** — Xcode не работает на Windows/Linux |
| Xcode | **16.0+** (iOS SDK 17+) |
| CocoaPods | `sudo gem install cocoapods` (или `brew install cocoapods`) |
| Node.js | 18+ с `npm` 7+ |
| Apple Developer | Аккаунт в команде с подписанным `com.forta.chat` App ID |

Проверь, что Xcode видит твой Apple ID: **Xcode → Settings → Accounts**. Без логина archive подписывать не сможет.

## Установка зависимостей

```bash
npm install
cd ios/App && pod install && cd -
```

`pod install` нужен после каждого добавления / удаления Capacitor-плагина (`npm install @capacitor/...`). Если CocoaPods жалуется на устаревший репозиторий — `pod repo update` или `pod install --repo-update`.

## Dev-сборка (симулятор)

```bash
npm run cap:build:ios
npm run cap:open:ios
```

`cap:build:ios` собирает Vite-bundle и синхронизирует его в `ios/App/public/` через Capacitor CLI. `cap:open:ios` открывает workspace в Xcode.

В Xcode:

1. Выбери схему **App** и симулятор (например, iPhone 15 Pro, iOS 17+).
2. **Run** (⌘R).

Альтернатива через CLI: `npm run cap:run:ios` — но Xcode даёт лучшую диагностику при первом запуске.

## Реальное устройство

1. Подключи iPhone, подтверди "Trust this computer".
2. В Xcode → target **App** → **Signing & Capabilities**:
   - Team: твоя команда Apple Developer.
   - Bundle Identifier: `com.forta.chat`.
   - Provisioning Profile: автоматический (Xcode подберёт сам, если все capabilities включены в App ID).
3. Выбери устройство в селекторе схемы, нажми **Run**.

Если Xcode жалуется на missing capability в profile — проверь, что в Apple Developer portal у App ID `com.forta.chat` отмечены все необходимые capabilities (Push Notifications, App Groups, Associated Domains — список ниже).

## Capabilities

Полный список iOS-capabilities, которые сейчас живут в `ios/App/App/App.entitlements`:

| Ключ | Значение | Зачем |
|---|---|---|
| `aps-environment` | `development` (release: `production`) | APNs push |
| `com.apple.developer.associated-domains` | `applinks:forta.chat`, `applinks:www.forta.chat` | Universal Links (`/invite/*`, `/join/*`) |
| `com.apple.security.application-groups` | `group.com.forta.chat` | App Group для NSE / Share Extension |

`ShareExtension.entitlements` и `NotificationService.entitlements` дублируют только App Group.

### Включение "Associated Domains" в Xcode UI (одноразово)

`App.entitlements` уже содержит правильный ключ — но Xcode ДОПОЛНИТЕЛЬНО требует, чтобы capability была видна в UI, иначе provisioning profile её не подхватит:

1. Открой `ios/App/App.xcworkspace`.
2. Target **App** → вкладка **Signing & Capabilities**.
3. Кнопка **+ Capability** → выбрать **Associated Domains**.
4. В появившейся секции Xcode уже увидит две записи из `App.entitlements`:
   - `applinks:forta.chat`
   - `applinks:www.forta.chat`
5. Если их нет — нажми "+" и добавь вручную (формат `applinks:<host>`, без `https://`).
6. Убедись, что у App ID `com.forta.chat` в Apple Developer portal стоит чекбокс **Associated Domains**. Если ставишь сейчас — Xcode → Preferences → Accounts → Download Manual Profiles, иначе profile не обновится.

После этого Xcode пересоберёт provisioning profile, и Universal Links начнут работать на установленных через TestFlight / Xcode-Run сборках.

## AASA (Apple App Site Association)

Файл `apple-app-site-association` хостится **не в этом репо**, а на `https://forta.chat/.well-known/apple-app-site-association` и `https://www.forta.chat/.well-known/apple-app-site-association`. Шаблон и инструкции для web-команды:

- `docs/plans/ios/aasa-template.json` — содержимое (замени `<TEAM_ID>` на реальный 10-символьный Apple Team ID).
- `docs/plans/ios/aasa-DEPLOYMENT.md` — HTTP-требования, nginx/Apache snippets, чек-лист проверки.

### Локальная проверка AASA с Mac

```bash
sudo swcutil dl -d forta.chat
sudo swcutil dl -d www.forta.chat
```

Ожидаемый вывод:

```
Entry:
  Domain: forta.chat
  Site/Fmwk Approval: approved
  AppID: <TEAM_ID>.com.forta.chat
  Patterns:
    /invite/*
    /join/*
```

Если `swcutil` ругается — см. таблицу типовых проблем в `aasa-DEPLOYMENT.md`.

### Manual-тест Universal Links

После деплоя AASA и установки сборки с обновлённым provisioning profile:

1. Из Safari открой `https://forta.chat/invite?ref=<bastyon-addr>` — приложение должно открыться сразу, без редиректа в Safari/баннера.
2. Из Mail / Notes тапни `https://forta.chat/join?room=<roomId>` — тот же эффект.
3. Закрой приложение (swipe-up), тапни линк ещё раз — cold-start должен зайти в invite/join.
4. Открой приложение, в Notes тапни линк — warm-start, переход без перезапуска.

Если шаг 1 проваливается:
- Xcode → Window → Devices and Simulators → выбрать устройство → "Open Console" → фильтр `swc:`. Apple's daemon логирует, почему AASA не прошёл.
- iOS кеширует AASA **per install**. Если AASA выкатили после установки приложения — переустанови билд (TestFlight / Xcode Run заново).

## Archive для TestFlight / App Store

1. В Xcode схема → **Any iOS Device (arm64)** (не симулятор).
2. **Product → Archive**.
3. После окончания откроется Organizer → **Distribute App → App Store Connect → Upload**.
4. Подождать обработки билда в App Store Connect (10–60 минут).
5. В TestFlight → Internal Testing → выбрать билд → пригласить тестеров.

Перед первым archive проверь:
- В `App.entitlements` `aps-environment` = `production` (Xcode подменит при release-builds — но проверь).
- `MARKETING_VERSION` и `CURRENT_PROJECT_VERSION` в project settings подняты.
- `GoogleService-Info.plist` (Firebase iOS) лежит в `ios/App/App/` и НЕ закоммичен (см. `docs/plans/ios/SECRETS-MANIFEST.md`).

## Справка

| Параметр | Значение |
|---|---|
| Bundle ID | `com.forta.chat` |
| App Group | `group.com.forta.chat` |
| Capacitor | 8.2 |
| iOS deployment target | 13.0 (Capacitor 8 default) |
| Xcode | 16+ |
| iOS SDK | 17+ |
| URL scheme (custom) | `forta://` (внутренний — Share Extension wake-up) |
| Universal Link hosts | `forta.chat`, `www.forta.chat` |
| Universal Link paths | `/invite/*`, `/join/*` |

## Где искать причины

| Симптом | Первая проверка | Ссылка |
|---|---|---|
| Universal Link открывает Safari, а не app | AASA отдаётся как `application/json` без редиректа? AppID/TeamID совпадают? | `aasa-DEPLOYMENT.md` |
| Xcode: "Provisioning profile doesn't include com.apple.developer.associated-domains" | Capability включена в Apple Developer portal? Download Manual Profiles? | этот документ, секция Capabilities |
| Cold-start invite не подхватывается | iOS Console: `appUrlOpen` fired? JS: `[deep-link-handler] App.getLaunchUrl failed`? | `src/app/providers/initializers/deep-link-handler.ts` |
| `pod install` падает | `pod repo update` и повторить | CocoaPods docs |
| Push token не приходит | Реальное устройство (не симулятор)? `aps-environment` правильный? `GoogleService-Info.plist` для нужного bundle? | `docs/plans/ios/2026-05-12-ios-apns-push.md` |
