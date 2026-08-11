# Roadmap: AI-чаты в Forta Chat (`local-ai`)

См. [основной план](./2026-08-11-local-ai-integration-plan.md) для контекста и обоснования решений.
Задачи размечены агенто-размерными шагами (несколько файлов, один проверяемый результат) — по образцу
`ROADMAP.md` самой библиотеки `local-ai`. `[ ]` — не начато, `[x]` — сделано, `[-]` — сознательно
отложено/вне объёма.

**Как пользоваться:** брать первую `[ ]` задачу с закрытыми зависимостями. Каждая фаза с нативным кодом
заканчивается ручной проверкой на реальном Android-устройстве — не считать фазу закрытой без неё (см.
план §1 — Capacitor-адаптеры `local-ai` не проверялись на устройстве авторами библиотеки).

Верификация перед коммитом на каждом шаге — по правилам `CLAUDE.md`: `npm run build`, `npm run lint`,
`npx vue-tsc --noEmit`, `npm run test`, плюс код-ревью (`review`/`review-fix`/`review-team` — по масштабу).

---

## Фаза 0 — Зависимости, спайк, продуктовые решения

Блокирует всё остальное. Ничего из Фазы 1+ не начинать, пока пункты 0.1–0.4 не закрыты.

- [ ] **0.1 Продуктовые решения** — закрыть открытые вопросы плана (§9, пункты 1, 2, 3, 4, 6) хотя бы
  временными плейсхолдерами, задокументированными как плейсхолдеры (не молча зашитыми): хостинг
  `manifestUrl`, конкретный HF-репозиторий + pinned revision модели, embedding-артефакт-плейсхолдер,
  Android-only vs Android+iOS, лицензионное ОК на MPL-2.0 `@capgo/capacitor-downloader`.
- [ ] **0.2 Собрать `local-ai` локально** — `pnpm install && pnpm build` в `C:\inetpub2026\localai`,
  подтвердить `dist/` собирается для всех трёх subpath-экспортов (`.`, `./adapters/capacitor`,
  `./adapters/node-testing`).
- [ ] **0.3 Подключить как `file:` зависимость** — `npm install file:../../inetpub2026/localai` в
  forta.chat, плюс `@capgo/capacitor-device-info`, `@capgo/capacitor-downloader`, `llama-cpp-capacitor`,
  `@capacitor-community/sqlite`. `npx cap sync android`. Подтвердить сборка Android не падает.
- [ ] **0.4 Замер размера APK** — release-сборка до/после добавления нативных плагинов, зафиксировать
  дельту. Если критично велика — решить: все ABI или только `arm64-v8a`/`armeabi-v7a` (Android 7
  совместимость, см. план §5.1).
- [ ] **0.5 Ручной спайк на реальном Android-устройстве** — минимальный скрипт/экран вне продовой ветки:
  `checkSupport()` → `create()` → `checkDeviceEligibility()` → `ensureModelReady()` с прогрессом →
  `createChat` (Mode A, для спайка проще) → `sendMessage` → получить токены. Цель — подтвердить, что
  `llama-cpp-capacitor`/`@capacitor-community/sqlite`'s `loadExtension`/`@capgo/capacitor-downloader`
  реально работают в этом проекте, а не только «по документации плагина» (план §1, §10). Завести ADR
  под `docs/plans/llama2/adr/` для каждого неожиданного расхождения с ожиданиями библиотеки.
- [ ] **0.6 Android 7 (minSdk 24) smoke** — если есть доступ к устройству/эмулятору Android 7–8: тот же
  спайк, чтобы понять, деградирует ли фича корректно (eligibility `'no'`/`checkSupport` false) вместо
  краша, на нижней границе поддержки.

**Критерий закрытия фазы:** ADR по 0.5 (accepted/rejected с зафиксированным фолбэком), APK-дельта
измерена, продуктовые решения 0.1 записаны (даже если временные).

---

## Фаза 1 — Dexie: схема и репозитории

Зависит от: 0.1 (не блокирует технически, но название таблиц/полей может зависеть от решений).

- [ ] **1.1 `LocalAiChat`/`LocalAiMessage` типы** — `src/shared/lib/local-db/schema.ts`, `version(18)`
  (копирует все существующие таблицы без изменений + добавляет `aiChats`/`aiMessages`, план §3).
- [ ] **1.2 `AiChatRepository`** — `src/shared/lib/local-db/ai-chat-repository.ts` — `getAll`/`get`/
  `create`/`rename`/`touch` (обновление `updatedAt`/`lastMessagePreview`)/`delete`, по образцу
  `channel-repository.ts`. Unit-тесты (`ai-chat-repository.test.ts`, fake-indexeddb — уже используется в
  проекте, см. `vitest.config.ts`).
- [ ] **1.3 `AiMessageRepository`** — `src/shared/lib/local-db/ai-message-repository.ts` —
  `listByChat(chatId)`/`create`/`updateContent`/`updateStatus`/`deleteByChat` (каскад при удалении
  чата). Unit-тесты.
- [ ] **1.4 Каскадное удаление** — `AiChatRepository.delete(id)` вызывает
  `AiMessageRepository.deleteByChat(id)` в одной Dexie-транзакции. Тест на «удаление чата не оставляет
  сирот в `aiMessages`».

**Критерий закрытия:** `npm run test` зелёный на новых репозиториях, миграция `version(18)` проходит на
существующей тестовой БД без потери данных других таблиц.

---

## Фаза 2 — `entities/local-ai`: владелец рантайма `LocalAiClient`

Зависит от: 0.2–0.3 (пакет должен быть установлен и собираться).

- [ ] **2.1 Сборка портов** — `src/entities/local-ai/lib/create-client.ts` — собирает `LocalAiPorts` из
  `local-ai/adapters/capacitor` (план §5), с per-account `databaseName` для `CapacitorSqliteAdapter`
  (план §4.2). Принимает `address` (текущий Bastyon-адрес) параметром, а не читает стор изнутри —
  чистая тестируемая функция. Настраивает `config.logger` (→ `console.warn`/`console.error` с
  префиксом `[LocalAi]`, по проектным соглашениям `CLAUDE.md`; `debug`/`info` — no-op) и
  `config.logging: { enabled: true, minLevel: 'warn' }` (план §11 — уровень уточнить, не `'debug'`,
  чтобы не забивать лимит `maxEntries`).
- [ ] **2.2 `useLocalAiStore`** — `src/entities/local-ai/model/local-ai-store.ts` — состояние:
  `client`, `supportReport`, `eligibilityReport`, `downloadState.{model,embedding}`, `modelReady`,
  `isGenerating`, `initError`. Методы: `ensureClient()`, `checkSupportOnce()`, `refreshManifest()`,
  `checkEligibility()`, `downloadModel()` (только `ensureModelReady`, план §6), `releaseRuntime()`.
  Unit-тесты с фейковыми портами (`local-ai/adapters/node-testing` — библиотека уже даёт фейки,
  переиспользуем их напрямую в тестах Forta Chat, не пишем свои с нуля).
- [ ] **2.3 Подписка на события `local-ai`** — `client.on('download:progress', ...)`,
  `on('manifest:updated', ...)`, `on('device:eligibility-warning', ...)` → обновляют стор. Тест на то,
  что события реально долетают до реактивного состояния (через фейковый `LlmRuntimePort`/download-порт).
- [ ] **2.4 Lifecycle-хуки** — `releaseRuntime()` на logout и на переключение аккаунта (симметрично
  `closeChatDb()`), пересоздание клиента с новым `databaseName` при `switchAccount`. Тест на то, что
  клиент аккаунта A не остаётся активным после переключения на B.

**Критерий закрытия:** `useLocalAiStore` полностью тестируем в Node через `local-ai`'s Node/fake-адаптеры
(без устройства), логика lifecycle/eligibility/progress зелёная.

---

## Фаза 3 — `entities/ai-chat`: Mode B поверх Dexie + `local-ai`

Зависит от: Фаза 1 (Dexie), Фаза 2 (клиент готов).

- [ ] **3.1 `useAiChatStore`** — `src/entities/ai-chat/model/ai-chat-store.ts` — `chats` через
  `useLiveQuery(() => aiChatRepository.getAll())`, `activeChatId`, `messagesByChat` (аналог
  `useLiveQuery` per-chat).
- [ ] **3.2 `createChat(title?)`** — пишет в Dexie немедленно, затем (если клиент уже создан и модель
  готова) вызывает `client.upsertChat({ id, title })` — не блокирует UI на сетевой/файловый вызов
  (план §4.1, п.1: создание чата не ждёт модель).
- [ ] **3.3 `sendMessage(chatId, text)`** — Mode B поток (план §2): пишет user-сообщение в Dexie
  оптимистично (`status: 'complete'`), создаёт пустую assistant-строку (`status: 'streaming'`),
  вызывает `client.upsertChat` + `client.appendMessages` + `client.sendMessage(chatId, text,
  { userMessageId, assistantMessageId, signal })`, копит токены в `streamingContent` (в памяти, не в
  Dexie на каждый токен — план §7.3), периодический чекпоинт в Dexie, финальная запись на
  `stream.result`. **`appendMessages` — не полная история на каждый вызов**: `appendMessages`
  идемпотентен по `(chatId, id)`, но заливать весь `getMessages`-эквивалент из Dexie перед *каждым*
  сообщением — лишние insert-with-conflict-check в длинном диалоге. Держать high-water mark (например
  id/count последнего доливавшегося сообщения на чат, в сторе или в `LocalAiChat`) и доливать только
  реально новое; полный `appendMessages` — один раз при первом открытии/создании чата за сессию.
- [ ] **3.4 Отмена генерации** — `cancelMessage(chatId)` дёргает `AbortSignal`, ожидаемый результат —
  `status: 'cancelled'` с частичным content, сохранённым как есть (ТЗ §9.8, без специальной обработки
  с нашей стороны — библиотека уже это гарантирует).
- [ ] **3.5 `RuntimeBusyError` UX** — `isGenerating` в `useLocalAiStore` блокирует `sendMessage` во всех
  AI-чатах одновременно, не только в активном (план §7.3). Тест на прямую попытку двух параллельных
  `sendMessage`.
- [ ] **3.6 `renameChat`/`deleteChat`** — `renameChat` → Dexie + `client.upsertChat({id, title})`;
  `deleteChat` → Dexie каскад (Фаза 1.4) + `client.deleteChat(id)`.
- [ ] **3.7 Интеграционный тест Mode B** — вручную (или через `local-ai`'s node-testing адаптеры)
  подтвердить: два вызова `appendMessages` с пересекающимися id не дублируют сообщения (библиотечная
  гарантия, но стоит закрыть тестом и на нашей стороне интеграции — регрессия на будущее).

**Критерий закрытия:** отправка/приём/отмена сообщения работает end-to-end на фейковых
`local-ai`-портах в Node-тестах; переключение между двумя AI-чатами не теряет историю.

---

## Фаза 4 — UI: вкладка «AI» в сайдбаре

Зависит от: Фаза 3.

- [ ] **4.1 `activeFilter` += `"ai"`** — `ChatSidebar.vue`, `visibleTabValues` (план §7.1: видимость по
  `isNative`, не по наличию данных — в отличие от `channels`).
  `<template #ai><AiChatList ... /></template>` в `SwipeableTabs`.
- [ ] **4.2 `AiChatList.vue`** — `src/features/ai-chat/ui/AiChatList.vue`, по образцу `ChannelList.vue`,
  список из `useAiChatStore().chats`, пустое состояние («ещё нет AI-чатов»).
- [ ] **4.3 Контекстная кнопка «новый чат»** — `ChatSidebar.vue` шапка, `v-if="activeFilter === 'ai'"`
  (план §7.2), `handleNewAiChat` → `createChat()` → открыть чат.
- [ ] **4.4 i18n-ключи** — `ai.newChat`, `ai.emptyState`, `ai.tabLabel` и т.д. во всех языковых файлах
  проекта (сверить со списком существующих локалей).
- [ ] **4.5 Android back-button** — если открыт AI-чат, аппаратная кнопка «назад» должна вести себя как
  для обычного чата (закрыть чат → назад в список) — переиспользовать существующий
  `useAndroidBackHandler`-паттерн (`ChatSidebar.vue` уже показывает пример регистрации приоритетных
  хендлеров).

**Критерий закрытия:** вкладка «AI» видна только на native-сборке, кнопка создаёт чат и открывает его,
Android back работает как в остальных вкладках.

---

## Фаза 5 — UI: `AiChatView.vue` (окно чата)

Зависит от: Фаза 3, Фаза 4. **Согласовать зону правок composer'а с разработчиком, ведущим клавиатурную
задачу, до начала (план §7.3, §10 риски).**

- [ ] **5.1 `AiModelGate.vue`** — общий виджет «модель не готова» (план §7): три состояния — не скачана
  (кнопка «Скачать» + описание размера), скачивается (прогресс-бар из `useLocalAiStore().downloadState`),
  eligibility-блок (`verdict === 'no'`, читаемое объяснение, без кнопки «всё равно скачать» — политика
  `block` по умолчанию, план §9 п.5). Переиспользуется в Фазе 6 (Settings) — писать один раз здесь.
- [ ] **5.2 `AiChatView.vue`** — список сообщений (переиспользовать существующий виртуальный
  скроллер/`ChatVirtualScroller`, не писать новый), рендер `role: user/assistant`, `status: streaming`
  показывает курсор/индикатор печати.
- [ ] **5.3 Composer-интеграция** — переиспользовать существующий компонент ввода из
  `features/messaging` (план §7.3), колбэк отправки переключён на `aiChatStore.sendMessage` вместо
  Matrix-отправки. Кнопка отправки дизейблится при `isGenerating` (Фаза 3.5), появляется кнопка
  «стоп»/отмена во время генерации.
- [ ] **5.4 In-chat статус-баннер** — над списком сообщений: если `downloadState.model` активен —
  прогресс; если `!modelReady` — CTA на скачивание (использует `AiModelGate.vue` из 5.1, не дублирует
  логику, план §4.1 п.2).
- [ ] **5.5 Обработка ошибок генерации** — `status: 'error'` сообщение рендерится отдельным стилем
  (приглушённый текст + иконка ошибки), без падения экрана.

**Критерий закрытия:** ручной прогон на реальном Android-устройстве — от пустого чата до полученного
потокового ответа, отмена генерации, повторное сообщение в том же чате заметно быстрее первого
(session-cache reuse, TЗ §9.3 — стоит подтвердить визуально, не только доверять юнит-тестам).

---

## Фаза 6 — UI: Settings → Local AI

Зависит от: Фаза 2 (стор), Фаза 5.1 (`AiModelGate.vue` переиспользуется частично).

- [ ] **6.1 `SettingsSubView` += `'localAi'`** — `use-sidebar-tab.ts`.
- [ ] **6.2 Кнопка в `SettingsPanel.vue`** — `v-if="isNative"`, по образцу существующих пунктов меню,
  между Storage и Networking (план §8).
- [ ] **6.3 `LocalAiSettingsSection.vue`** — `src/features/settings/ui/LocalAiSettingsSection.vue`, по
  образцу `TorSettingsSection.vue`/`StorageSettings.vue`: инфо о модели, eligibility-бейдж, кнопки
  скачать/обновить/удалить, прогресс-бар (тот же `downloadState`, план §8 п.4), «проверить обновления»
  (`refreshManifest()`).
- [ ] **6.4 Роутинг в `SettingsContentPanel.vue`** — добавить ветку `settingsSubView === 'localAi'`.
- [ ] **6.5 «Удалить модель»** — решить открытый вопрос плана §9 п.7 (нужен ли API-метод в `local-ai`,
  или обходимся `releaseRuntime({closeDatabase:true})` + прямым удалением файла через
  `FileSystemPort`-путь, который стор уже знает). Если нужен метод библиотеки — завести
  задачу/issue в `C:\inetpub2026\localai`, не патчить `node_modules`/`dist` руками.

**Критерий закрытия:** прогресс-бар в Settings и в открытом AI-чате показывают одно и то же число
одновременно (один стор, план §8 п.4) — проверить вручную, открыв оба экрана в параллельных вкладках
приложения (если платформа позволяет) или последовательно во время активной загрузки.

---

## Фаза 7 — Lifecycle, память, полировка

Зависит от: Фазы 2–6 в целом готовы.

- [ ] **7.1 `autoUnloadOnBackground`** — решить, включать ли (`LocalAiConfig.autoUnloadOnBackground`) —
  компромисс память/задержка возврата (ТЗ §11.2); задокументировать выбор в плане, не оставлять
  implicit default.
- [ ] **7.2 `releaseRuntime()` на logout/переключение аккаунта** — подтвердить Фазой 2.4, добавить
  ручной тест сценария «выйти из аккаунта во время активной генерации» (должен либо корректно
  отменить, либо не крашить остальной logout-путь — сверить с
  `docs/plans/2026-03-30-logout-data-cleanup.md`).
- [ ] **7.3 Tor bypass для загрузки модели** — подтвердить (план §10), что `@capgo/capacitor-downloader`
  не проходит через `tor-service.ts`'s прокси; если проходит — явно исключить домен HF/CDN манифеста из
  Tor-маршрутизации.
- [ ] **7.4 Ручной QA-чеклист** — минимум одно слабое Android 7/8 устройство (или максимально близкий
  эмулятор) + одно современное — полный сценарий: открыть вкладку AI → (не)доступность по eligibility →
  скачать модель → создать чат → отправить/получить/отменить сообщение → переключить аккаунт → проверить
  изоляцию истории → Settings → Local AI показывает согласованное состояние.
- [ ] **7.5 Полная верификация перед PR** — `npm run build`, `npm run lint`, `npx vue-tsc --noEmit`,
  `npm run test`, код-ревью (`review-team` — учитывая масштаб: новая БД-схема + новый нативный слой +
  новый UI-раздел).
- [ ] **7.6 Логи `local-ai` → существующий бажрепорт** (план §11) — прикладывать
  `client.exportLogs({ limit: 200 })` к телу репорта, отправляемого через `features/bug-report`, когда
  репорт открыт из контекста AI (AI-чат или Settings → Local AI). Не отдельная кнопка «Export AI logs»
  — встроить в существующий флоу сбора диагностики (`getLocalIssueCache`). Особенно ценно здесь: это
  единственный канал получить диагностику с реальных устройств, на которых Capacitor-адаптеры
  `local-ai` не тестировались авторами библиотеки (план §1, §10).

**Критерий закрытия:** чеклист 7.4 пройден вручную, все автоматические проверки CLAUDE.md зелёные.

---

## Фаза R — RAG / эмбеддинги (заблокирована)

⛔ Не начинать до закрытия Фаз 0–7. Соответствует старому заблокированному плану
`docs/plans/llama/2026-08-08-local-ai-knowledge-rag-plan.md`, но на новом фундаменте (`local-ai`
вместо самодельной LoRA-адаптерной схемы). Объём — отдельный документ, когда будет запрошен:
скачивание embedding-артефакта (`ensureEmbeddingReady()`, план §6), `client.vectors.*`, возможный
поиск по истории AI-чатов или knowledge packs.
