# Electron Desktop — планы

Интеграция Forta Chat как приложения Win / macOS / Linux через Electron.

| Документ | Назначение |
|----------|------------|
| [electron-desktop-integration-plan.md](./electron-desktop-integration-plan.md) | Основной план: baseline → packaging → UX → updates → CI |
| [packaging-checklist.md](./packaging-checklist.md) | Чеклист сборки и релиза installers |
| [signing-and-updates.md](./signing-and-updates.md) | Phase 3: electron-updater, GitHub publish, signing env |
| [ci-desktop.md](./ci-desktop.md) | Phase 4: desktop-smoke + desktop-release workflows |
| [smoke-checklist.md](./smoke-checklist.md) | Phase 0–2: ручной smoke на Win + команды верификации |

## Статус фаз

| Фаза | Статус |
|------|--------|
| 0 Baseline (типы, smoke, single-instance) | ✅ |
| 1 Packaging hardening (icons, asar, entitlements) | ✅ (Linux AppImage — на runner) |
| 2 Desktop UX (tray, deep links, badge, login item, zoom) | ✅ код готов; ручной smoke на Win |
| 3 Auto-update + signing | ✅ код готов (publish/signing — secrets + CI) |
| 4 CI/CD | ✅ workflows; secrets signing — по мере появления |
| 5 QA / user docs | частично (чеклисты + signing-and-updates + ci-desktop) |

## Быстрые команды

```bash
npm run electron:dev          # Vite + Electron (HMR)
npm run electron:preview      # vite build → Electron
npm run electron:smoke        # vite build → boot + exit (CI)
npm run electron:build:win
npm run electron:build:mac
npm run electron:build:linux
```

Артефакты: `release/` (gitignored).

CI: `.github/workflows/desktop-smoke.yml` (PR), `desktop-release.yml` (tag `v*`).

Deep links: `forta://join?room=<id>`, `forta://room/<id>`, `forta://invite?ref=<addr>`.

## Связанное

- Tor в Electron: [`../tor/forta-chat-tor-integration-plan.md`](../tor/forta-chat-tor-integration-plan.md)
- Platform layer: `src/shared/lib/platform/index.ts`
- Electron API types: `src/shared/types/electron.ts`
- Main / preload: `electron/main.cjs`, `electron/preload.cjs`
