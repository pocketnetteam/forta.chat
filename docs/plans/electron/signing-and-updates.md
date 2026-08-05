# Code signing & auto-update (Phase 3)

Подпись и публикация обновлений для Forta Chat Desktop. Сборка без сертификатов по-прежнему работает (`forceCodeSigning: false` в `electron-builder.json`).

## Auto-update

- Runtime: `electron-updater` (`electron/auto-updater.cjs`)
- Provider: GitHub Releases (`pocketnetteam/forta.chat`)
- После `app.ready` (packed build) — отложенный `checkForUpdatesAndNotify`
- UI: Settings → Desktop → Updates (`useAutoUpdate`)
- IPC: `update:get-status`, `update:check`, `update:quit-and-install`, события `update:*`
- Отключить: `FORTA_DISABLE_AUTO_UPDATE=1` или Vite/dev (`VITE_DEV_SERVER_URL`)

Publish (локально или CI):

```bash
# Требует GH_TOKEN / GITHUB_TOKEN с правом repo (releases)
npx electron-builder --config electron-builder.json --win --publish always
```

Publish на tag создаёт **draft** GitHub Release (`releaseType: draft` в `electron-builder.json`).
На draft должны появиться installer + `latest.yml` / `latest-mac.yml` / `latest-linux.yml`
(плюс Android assets из того же `release.yml`). Draft не виден `electron-updater` —
сначала подпиши Win локально / замени `latest.yml`, затем Publish в UI GitHub.

Критерий Phase 3: установка vN → публикация vN+1 → приложение предлагает обновиться и перезапускается.

## Signing

`forceCodeSigning` остаётся `false` в репозитории. На **release CI** включается автоматически, если заданы cert secrets (`MAC_CSC_*` / `WIN_CSC_*` или `CSC_*`) — см. [ci-desktop.md](./ci-desktop.md):

```bash
npx electron-builder --config electron-builder.json --win -c.forceCodeSigning=true --publish always
```

Не включать на PR / unsigned smoke builds.

### Windows

| Env | Назначение |
|-----|------------|
| `CSC_LINK` | Путь или base64 к `.pfx` |
| `CSC_KEY_PASSWORD` | Пароль сертификата |
| или Azure Trusted Signing | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, … (см. electron-builder docs) |

### macOS

| Env | Назначение |
|-----|------------|
| `CSC_LINK` / keychain | Developer ID Application |
| `APPLE_ID` | Apple ID для notarize |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | Team ID |

Entitlements: `electron/entitlements.mac.plist` (Tor spawn + camera/mic). Hardened Runtime уже включён в `electron-builder.json`.

### Linux

Подпись опциональна (GPG для `.deb`). AppImage обновляется через `latest-linux.yml` без обязательной подписи.

## Чеклист перед публичным релизом

См. [packaging-checklist.md](./packaging-checklist.md) — секции Signing и Publish.
