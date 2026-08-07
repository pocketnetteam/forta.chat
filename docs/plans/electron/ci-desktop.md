# Release CI/CD (desktop + Android)

Один tag-workflow собирает Desktop и Android в **draft** GitHub Release. Публикация — вручную после локальной подписи Windows.

## Workflows

| Workflow | Триггер | Назначение |
|----------|---------|------------|
| [release.yml](../../../.github/workflows/release.yml) | tag `v*` + `workflow_dispatch` | Desktop (Win/mac/Linux) + Android APK/AAB → **draft** Release |
| [desktop-smoke.yml](../../../.github/workflows/desktop-smoke.yml) | PR (paths: electron/src/…) + `workflow_dispatch` | `vite build` + boot smoke под xvfb |
| [android-release.yml](../../../.github/workflows/android-release.yml) | только `workflow_dispatch` | Android-only ad-hoc (artifacts, без tag/Release) |

Не путать с `android-test-apk.yml` (тестовые APK) и `deploy.yml` (web).

## Локальный smoke (desktop)

```bash
npm run electron:smoke
# или: npx vite build && node scripts/electron-smoke.cjs
```

Режим `FORTA_ELECTRON_SMOKE=1`: без tray/auto-updater, Tor `neveruse`, выход после `did-finish-load` с логом `[smoke] ok`.

## Release (tag `v*`)

1. Версия в `package.json` = тег без `v` (например `1.12.0` ↔ `v1.12.0`). CI падает, если не совпадает.
2. Push tag `v*` → job `desktop` (matrix win/mac/linux) + job `android` параллельно.
3. Desktop: `electron-builder --publish always` с `releaseType: draft` в `electron-builder.json`.
   Подпись Win/mac — если заданы cert secrets; иначе unsigned (типично: Win подписывается локально).
4. Android: signed APK + AAB → `softprops/action-gh-release` с `draft: true` в тот же draft.
5. Artifacts дублируются в Actions (`desktop-{win|mac|linux}-…`, `android-…`) на 14 дней.
6. **Вручную:** скачать/собрать Win → подписать → заменить installer + `latest.yml` на draft (`gh release upload … --clobber`) → **Publish release** в GitHub.

`workflow_dispatch` без тега: desktop с `--publish never` + android только как Actions artifacts (без Release).

## Secrets (signing)

Без сертификатов desktop-сборка **unsigned** (`forceCodeSigning: false`, пока нет `CSC_*`).  
С сертификатами desktop job добавляет `-c.forceCodeSigning=true`.

| Secret | ОС | Назначение |
|--------|-----|------------|
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows | base64 `.pfx` + пароль (опционально; часто локально) |
| `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` | macOS | base64 `.p12` + пароль |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | fallback | общие, если platform-specific не заданы |
| `APPLE_ID` | macOS | notarize |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS | notarize |
| `APPLE_TEAM_ID` | macOS | notarize |
| `ANDROID_KEYSTORE` + passwords/alias | Android | release APK/AAB |
| `GOOGLE_SERVICES_JSON` | Android | Firebase |
| `GITHUB_TOKEN` | все | уже есть у Actions (`contents: write`) → `GH_TOKEN` |

Подробности desktop: [signing-and-updates.md](./signing-and-updates.md).

## Кэш

- `actions/setup-node` → npm cache
- `actions/cache` → Electron / electron-builder download dirs по OS
- `actions/setup-java` → gradle cache (android job)

## Чеклист после tag → перед Publish

- [ ] Draft Release содержит Win/mac/Linux + `latest*.yml` + Android APK/AAB
- [ ] Win installer подписан локально; `latest.yml` обновлён (sha512/size)
- [ ] (если secrets) mac notarize без ошибок в логах
- [ ] Publish draft → updater видит релиз; smoke vN → vN+1
