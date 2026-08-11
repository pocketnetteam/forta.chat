# Local AI (llama.cpp) — планы

Оффлайн-инференс LLM внутри Forta Chat через [`llama-cpp-capacitor`](https://www.npmjs.com/package/llama-cpp-capacitor):
одна базовая GGUF-модель + набор LoRA-адаптеров, где **каждый адаптер = отдельный AI-чат**.
Модель и адаптеры качаются **по требованию**, не входят в билд.

| Документ | Назначение |
|----------|------------|
| [2026-08-08-local-ai-llama-cpp-plan.md](./2026-08-08-local-ai-llama-cpp-plan.md) | Основной план: research → runtime → download → адаптеры-чаты → eligibility/updates → UX |
| [2026-08-08-local-ai-knowledge-rag-plan.md](./2026-08-08-local-ai-knowledge-rag-plan.md) | Knowledge packs / RAG (LoRA + тексты/embedding). ⛔ после основного плана |

## Статус фаз

| Фаза | Статус |
|------|--------|
| 0 Research / feasibility (API плагина, ограничения) | ✅ (см. основной план) |
| 1 Нативная интеграция (`cap sync`, NDK/Xcode, размер билда) | ⬜ |
| 2 Runtime wrapper + eligibility (`canRun` + device-info) | ⬜ |
| 3 On-demand download (base + adapters) + progress UI | ⬜ |
| 3.5 Каналы и фильтрация (`filtered` / `unfiltered`) | ⬜ |
| 4 Адаптер-как-чат + вкладка AI / Settings Local AI | ⬜ |
| 5 Обновления: patch / upgrade / replace + lifecycle манифеста | ⬜ |
| 6 UX/Settings, bench-калибровка, тесты | ⬜ |
| R* Knowledge packs / RAG | ⛔ blocked до закрытия фаз 1–6 основного плана |

## Ключевые решения

- **Только native (Android/iOS).** У `llama-cpp-capacitor` 0.1.5 Web = ❌ → на web/Electron фича скрыта через `isNative`.
- **Адаптер ≠ история.** LoRA задаёт поведение модели; сообщения живут в Dexie как у обычных чатов.
- **Immutable filenames + registry.** Файлы версионированы (`base__<id>__v3.gguf`), обновление = скачать новое → проверить → переключить → удалить старое.
- **После обновления базы адаптеры удаляются** и докачиваются лениво при входе в чат. История чатов не затрагивается.
- **Целевой размер моделей: 0.5B–4B Q4_K_M.** 7B не поддерживаем.
- **Хостинг моделей — Hugging Face** (`resolve/<rev>/<file>.gguf` с пиннингом ревизии).
- **Нет device tier (`low/mid/high`).** Eligibility: `canRun(model, deviceSnapshot)` по `minRamGb` / `recommendedRamGb` / disk + локальные verdicts (`tooSlow` / `oom`). Через годы меняются цифры в манифесте, не клиентский `pickTier`.
- **`@capgo/capacitor-device-info` — обязателен** (total/free RAM, storage, thermal) для eligibility.
- **Иерархия апдейтов:** patch (тот же id, новый файл) / upgrade (та же family, выше `qualityRank`) / replace (`deprecated` / `replacedBy`). Автосмены базы нет — только баннер/Settings.
- **Манифест не копится.** Remote = текущий каталог: `active` + кратко `deprecated`; `withdrawn` вычёркиваем. Диск чистится относительно registry + текущего манифеста.
- **`n_gpu_layers` — консервативно** (default `0`; Android — CPU).
- **Конкретный список моделей задаёт владелец продукта** — в манифесте placeholder'ы.
- **Цензура по каналу.** Play / App Store — только `filtered`. Sideload — `unfiltered` после Settings-тогла (**без 18+**). Флаг — `BuildConfig.ALLOW_UNFILTERED_MODELS`, не Vite env. Два манифеста + клиентский фильтр; fail-closed.
- **UI — список чатов:** вкладка **AI** рядом с All / Personal / Groups; AI-чаты также в **All**; в Personal/Groups не показываются (`ChatSidebar` + `filterRoomsForTab`).
- **UI — настройки:** отдельная группа **Local AI** в Settings (не внутри Storage).
- **Knowledge / RAG (отдельный план):** LoRA = «как», pack = «из чего»; texts + опц. embedding качаются on-demand; в промпт — тексты. ⛔ после основного плана.

## Связанное

- Platform layer: `src/shared/lib/platform/index.ts` (`resolveAppUpdaterEnabled` — образец для `resolveAllowUnfilteredModels`)
- Chat tabs: `src/widgets/sidebar/ChatSidebar.vue`, `src/entities/chat/lib/room-visibility.ts`
- Settings: `src/widgets/sidebar/ui/SettingsPanel.vue`, `SettingsContentPanel.vue`
- Android flavors: [`docs/android-local-build.md`](../../android-local-build.md), `android/app/build.gradle` (`sideload` / `play`)
- Дистрибуция / CI: `scripts/verify-android-distribution.mjs` (расширить на `ALLOW_UNFILTERED_MODELS`)
- Dexie / local-first: `src/shared/lib/local-db/`
- Файловые операции: `@capacitor/filesystem`, `src/shared/lib/file-transfer/`
- Tor: `src/shared/lib/tor/tor-service.ts` (загрузка моделей идёт **мимо** Tor — см. риски в плане)
