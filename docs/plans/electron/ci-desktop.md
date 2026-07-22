# Desktop CI/CD (Phase 4)

Автоматические сборки Forta Chat Desktop. Не смешивать с Android (`android-release.yml` / `cap:build`) — отдельные workflows.

## Workflows

| Workflow | Триггер | Назначение |
|----------|---------|------------|
| [desktop-smoke.yml](../../../.github/workflows/desktop-smoke.yml) | PR (paths: electron/src/…) + `workflow_dispatch` | `vite build` + boot smoke под xvfb |
| [desktop-release.yml](../../../.github/workflows/desktop-release.yml) | tag `v*` + `workflow_dispatch` | matrix Win/mac/Linux → GitHub Release |

## Локальный smoke

```bash
npm run electron:smoke
# или: npx vite build && node scripts/electron-smoke.cjs
```

Режим `FORTA_ELECTRON_SMOKE=1`: без tray/auto-updater, Tor `neveruse`, выход после `did-finish-load` с логом `[smoke] ok`.

## Release

1. Версия в `package.json` = тег без `v` (например `1.12.0` ↔ `v1.12.0`). CI падает, если не совпадает.
2. Push tag `v*` → три runner’а собирают `--win` / `--mac` / `--linux` с `--publish always`.
   `workflow_dispatch` без тега собирает installers с `--publish never` (только artifacts).
3. electron-builder заливает installers + `latest.yml` / `latest-mac.yml` / `latest-linux.yml` в GitHub Release того же тега (рядом с Android APK, если Android-job тоже бежит).
4. Artifacts дублируются в Actions (`desktop-{win|mac|linux}-…`) на 14 дней.

## Secrets (signing)

Без сертификатов сборка **unsigned** (как локально: `forceCodeSigning: false`).  
С сертификатами CI добавляет `-c.forceCodeSigning=true` и включает `CSC_IDENTITY_AUTO_DISCOVERY`.

| Secret | ОС | Назначение |
|--------|-----|------------|
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows | base64 `.pfx` + пароль |
| `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` | macOS | base64 `.p12` + пароль |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | fallback | общие, если platform-specific не заданы |
| `APPLE_ID` | macOS | notarize |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS | notarize |
| `APPLE_TEAM_ID` | macOS | notarize |
| `GITHUB_TOKEN` | все | уже есть у Actions (`contents: write`) → `GH_TOKEN` |

Подробности: [signing-and-updates.md](./signing-and-updates.md).

## Кэш

- `actions/setup-node` → npm cache
- `actions/cache` → Electron / electron-builder download dirs по OS

## Чеклист после первого tag-релиза

- [ ] На Release page есть Win NSIS/zip, mac DMG/zip, Linux AppImage/deb
- [ ] Есть `latest*.yml` для electron-updater
- [ ] (если secrets) подпись / notarize без ошибок в логах
- [ ] Установка vN → публикация vN+1 → Settings → Updates предлагает обновиться
