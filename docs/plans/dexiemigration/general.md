# Миграция с Dexie → matrix-js-sdk + Pcrypto + pSDK — General Plan

> **Статус:** DRAFT / RESEARCH. Это стратегический план-исследование, а не готовый чек-лист на выполнение.
> **Цель:** убрать прикладной слой Dexie (`src/shared/lib/local-db/`, БД `bastyon-chat-{userId}`) и сделать источниками правды уже существующие хранилища:
> - **`matrix-js-sdk-v6:{username}`** (IndexedDBStore SDK) — состояние комнат, чатов, таймлайнов, сообщений (сырые Matrix-события);
> - **Pcrypto `events:{address}`** — расшифрованный plaintext сообщений (E2EE-кэш);
> - **`files`** — медиа/файлы;
> - **`psdk_production`** (Bastyon SDK / ResoursesDB) — каналы (channels) и профили пользователей (users).
>
> **Итоговое обещание:** offline-first достигается за счёт SDK-стора (resume sync + accumulated room state) + Pcrypto-кэша, без второй копии данных в Dexie.

---

## 0. TL;DR и честная оценка

**Это крупная архитектурная переделка, а не рефакторинг.** Dexie сегодня — не «дублирующий кэш», а **единственный источник правды для UI** (все чтения идут через `useLiveQuery`/`observeRoomChanges` из Dexie). Кроме хранения он несёт 4 функции, которых **нет** в SDK/Pcrypto/pSDK «из коробки»:

1. **Оптимистичная отправка** (сообщение в UI до ответа сервера) + `clientId`-дедуп.
2. **Durable outbound-очередь** (`pendingOps` + `SyncEngine`): FIFO, backoff, media-пайплайн (encrypt→upload→send).
3. **Хранение расшифрованного домена** (`Message` с `fileInfo/pollInfo/reactions/...`) + retry расшифровки между перезапусками (`decryptionQueue`).
4. **Реактивность для Vue** (`useLiveQuery` поверх Dexie `liveQuery`).

Три критических факта из ресёрча, которые определяют весь план:

| Факт | Источник | Последствие |
|------|----------|-------------|
| SDK `IndexedDBStore` **не хранит полный таймлайн** — `SyncAccumulator` держит ~50 событий/комнату, а текущий sync-фильтр Forta режет до **4 событий/комнату**. `storeEvents()` — no-op, `scrollback()` из стора возвращает `[]`. | `matrix-js-sdk-bastyon/src/store/{indexeddb-local-backend,memory,sync-accumulator}.ts` | «Offline вся история» из одного SDK-стора **недостижимо** без изменения конфигурации SDK и/или собственного слоя персистентности истории. |
| Pcrypto `events:{address}` кэширует **только успешные** расшифровки, TTL **30 дней**, эвикция по часам. `messages:{address}` и `files` сейчас **создаются, но не используются**. | `src/shared/lib/matrix/chat-storage.ts`, `matrix-crypto.ts` | Pcrypto-кэш годится как decrypt-memo, но не как durable-хранилище plaintext (эвикция → повторная расшифровка). |
| Каналы Forta берутся из `getsubscribeschannels` (обогащённые: name/avatar/lastContent), а pSDK-стор `subscribes` — это `getusersubscribes` (сырой список адресов), **который Forta не читает**. | `app-initializer.ts:879-909`, `public/js/lib/client/sdk.js:3268` | Перенос channels в `psdk_production` требует либо переиспользования RPC-обёрток pSDK, либо переноса `getsubscribeschannels` под pSDK-кэш (ResoursesDB). |

> **Рекомендация ресёрча (для протокола):** технически «жить только на SDK-сторе» = переписать заново то, что уже есть в Dexie, с худшими индексами и без durable-очереди. План ниже показывает **как это сделать корректно, если решение принято**, с акцентом на минимизацию регрессий. Каждая фаза автономна и даёт ценность отдельно — можно остановиться на любой.

---

## 1. Карта «что где лежит сегодня»

### 1.1 Хранилища (IndexedDB)

| БД | Владелец | Что хранит | Роль сейчас |
|----|----------|------------|-------------|
| `bastyon-chat-{userId}` | **Dexie** `ChatDatabase` (v17, 13 таблиц) | rooms, messages, users(алиасы), pendingOps, syncState, attachments, decryptionQueue, listenedMessages, searchCache, channels, mediaCacheIndex, mediaCacheBlobs, callProviders | **SSOT для UI** |
| `matrix-js-sdk-v6:{username}` | SDK `IndexedDBStore` | sync-токен, accumulated `roomsData` (state+тонкий tail), accountData, presence, OOB-члены, to-device | Транспорт/resume sync |
| `events:{address}` | Pcrypto `lse` | расшифрованный plaintext `{body,msgtype}`, ключ `e_pcrypto10_{uid}-{eventId}` | decrypt-memo (TTL 30д) |
| `messages:{address}` | Pcrypto `ls` | — | **создан, не используется** |
| `files` | `MatrixClientService.db` | — | **создан, не используется** |
| `psdk_production` | Bastyon SDK `ResoursesDB` | userInfoFull/Light, subscribes, subscribers, blocking, share, ... (TTL) | Кэш профилей (через `psdk.userInfo`) |
| `bastyon-chat-cache` | legacy `chat-cache.ts` | rooms/messages (до Dexie) | почти мёртв, удаляется при logout |

### 1.2 Таблицы Dexie → куда переносить

| Таблица Dexie | Целевой источник | Сложность | Комментарий |
|---------------|------------------|-----------|-------------|
| `messages` | SDK timeline + Pcrypto `events` (plaintext) + **новый persist-слой истории** | 🔴 Critical | SDK не хранит полную историю → нужен либо persist истории, либо decrypt-on-render |
| `rooms` | SDK `getRooms()` + `room.currentState` + accountData | 🔴 Critical | derived-поля (preview, unread, aliases, tombstone) нужно вычислять на лету |
| `pendingOps` | SDK local echo (`Room.addPendingEvent`, `pendingEventOrdering:"detached"`) + localStorage-очередь | 🔴 Critical | требует переключить send-путь на SDK-очередь |
| `attachments` | media-пайплайн поверх `files` (Pcrypto) / SDK `uploadContent` | 🟠 High | связан с `pendingOps` |
| `decryptionQueue` | in-memory очередь + Pcrypto retry | 🟠 High | сейчас durable в Dexie; после миграции — память + `events`-кэш |
| `mediaCacheIndex`/`mediaCacheBlobs` | **`files`** (Pcrypto/IDB) + Capacitor FS (native) | 🟠 High | самодостаточный слой, мигрируется отдельно |
| `channels` | **`psdk_production`** (ResoursesDB) или собственный кэш поверх pSDK | 🟡 Medium | сейчас `getsubscribeschannels` → Dexie |
| `users` (только `localAlias`) | Matrix account_data `m.bastyon.contact_aliases` (уже синкается!) | 🟡 Medium | алиасы уже дублируются в account_data |
| `searchCache` | `psdk_production`/in-memory | 🟢 Low | TTL-кэш поиска |
| `listenedMessages` | localStorage / Matrix account_data | 🟢 Low | маленький set id |
| `callProviders` | localStorage (device-only) | 🟢 Low | несколько строк |
| `syncState` (`device_telemetry`, `sync_token`) | SDK sync-токен уже свой; telemetry → localStorage | 🟢 Low | `sync_token` в Dexie фактически не используется |

### 1.3 Реактивные пути чтения (что придётся заменить)

- **Path A — `useLiveQuery`** (`src/shared/lib/local-db/use-live-query.ts`): основная лента `activeMessages` (`chat-store.ts:1302-1316`), `callProviders` (ChatWindow, CallProvidersSection), `device_telemetry` (SettingsContentPanel).
- **Path B — `observeRoomChanges`** (Dexie hooks, `room-repository.ts:685-724`): sidebar-список комнат через `dexieRoomMap` (`chat-store.ts:1793`).
- **Path C — one-shot reads**: channels (cold-start), searchCache, listened, aliases.

> **Ключевой инженерный вывод:** миграция «умрёт» не на хранении, а на **реактивности**. Нужен `useMatrixLiveQuery` — мост Vue ↔ SDK `EventEmitter` (`Room.timeline`, `Room.LocalEchoUpdated`, `RoomState.events`, `Room.Receipt`, `Room.Redaction`), эквивалентный текущему `useLiveQuery`.

---

## 2. Целевая архитектура

```
                    Matrix HS  /sync, /messages, /send
                          │
                          ▼
        ┌─────────────────────────────────────────────┐
        │  matrix-js-sdk-bastyon  (SSOT комнат/событий) │
        │  - IndexedDBStore: sync token + room state    │
        │  - Room timelines (в памяти + persist-слой)   │
        │  - local echo (pendingEventOrdering:detached) │
        └───────────────┬─────────────────┬─────────────┘
                        │ ciphertext        │ EventEmitter
                        ▼                    ▼
             ┌──────────────────┐   ┌────────────────────────┐
             │ Pcrypto          │   │ useMatrixLiveQuery      │
             │ events:{addr}    │   │ (Vue reactive bridge)   │
             │ = plaintext memo │   └───────────┬────────────┘
             │ files = media    │               │
             └──────────────────┘               ▼
                                          Vue UI (MessageList,
                                          Sidebar, ChatWindow)
        ┌─────────────────────────────────────────────┐
        │  psdk_production (ResoursesDB)                │
        │  - userInfo (profiles)  → users               │
        │  - channels (getsubscribeschannels cache)     │
        └─────────────────────────────────────────────┘

  localStorage: callProviders, listened(опц.), telemetry, aliases-bootstrap
```

**Инварианты после миграции:**
1. Ни одно чтение UI не идёт из Dexie. `@/shared/lib/local-db` удалён.
2. Отправка использует SDK local echo как источник optimistic-состояния.
3. Расшифрованный текст живёт в Pcrypto `events`-кэше; при промахе — синхронная/фоновая расшифровка из SDK-события.
4. Каналы и профили читаются из pSDK.

---

## 3. Предварительные блокеры (сделать ДО фаз)

Без этих изменений «offline-first только на SDK» невозможен физически.

### Блокер B1 — SDK должен персистить историю таймлайна

Сейчас: `initialSyncLimit: 4`, sync-фильтр `timeline.limit=4`, `SyncAccumulator` ~50 событий. `store.scrollback()`→`[]`.

Нужно решить один из вариантов:
- **B1a (минимальный):** оставить историю «по требованию» — при открытии комнаты грузить `scrollback`/`paginateEventTimeline` из сети, кэшировать plaintext в Pcrypto `events`. Offline = только то, что уже в Pcrypto-кэше + accumulated tail. **Риск:** offline-история неполная (совпадает с текущим реальным поведением, т.к. Dexie тоже наполняется из scrollback).
- **B1b (полный):** ввести собственный persist истории поверх `files`/новой IDB-таблицы SDK-совместимого формата (по сути — то, что делает Dexie `messages`). Тогда Dexie не убирается, а **переименовывается**. Не рекомендуется как цель.

> **Файлы:** `src/entities/matrix/model/matrix-client.ts:286-347` (фильтр, initialSyncLimit), `sync-failover.ts`.

### Блокер B2 — Переключить send на SDK local echo

Сейчас: `use-messages.ts` → `messages.createLocal()` (Dexie) → `SyncEngine.enqueue` → `sendEncryptedText(txnId=clientId)`.

Нужно: `client.sendEvent(roomId, type, content, txnId)` с `pendingEventOrdering: "detached"`, чтение optimistic-состояния через `room.getPendingEvents()` + событие `Room.LocalEchoUpdated`, статусы `EventStatus.{SENDING,NOT_SENT,QUEUED}`.

> **Файлы:** `matrix-client.ts:243-268` (добавить `pendingEventOrdering`), `use-messages.ts:189-297`, `sync-engine.ts` (частично заменяется SDK-планировщиком; media-пайплайн остаётся кастомным).

### Блокер B3 — Реактивный мост `useMatrixLiveQuery`

Нужен новый composable в `src/shared/lib/matrix/` (или `entities/matrix`), подписывающийся на SDK `EventEmitter` и отдающий `ShallowRef`, с той же семантикой, что `use-live-query.ts` (keep-stale-on-resubscribe, deps-watch, dispose).

### Блокер B4 — Media-пайплайн на `files`/Capacitor без Dexie

`mediaCacheIndex/Blobs` + `attachments` → перенести на Pcrypto `files` (web) + Capacitor FS (native). Индекс LRU/бюджет — в localStorage или в `files`-IDB метаданными.

### Блокер B5 — Каналы и профили через pSDK

- Channels: перенести `getsubscribeschannels`-кэш в ResoursesDB (добавить storage в `dbmeta` `sdk.js`) **или** обернуть in-memory + один RPC (cold-start теряет мгновенный рендер — регресс WEE-24, нужно смягчить).
- Users/aliases: профили уже идут через `psdk.userInfo`; алиасы — читать из Matrix account_data `m.bastyon.contact_aliases` вместо Dexie `users`.

---

## 4. Фазовый план

> Каждая фаза = отдельный PR/worktree (по правилам CLAUDE.md — изоляция worktree). После каждой фазы: `npm run build`, `npm run lint`, `npx vue-tsc --noEmit`, `npm run test`, code-review. Порядок — от низкого риска к критическому, чтобы «разгрузить» Dexie постепенно.

### Фаза 0 — Подготовка и фундамент (низкий риск)

**Задачи:**
- 0.1 Создать `useMatrixLiveQuery` (Блокер B3) + unit-тесты на семантику подписки/отписки. Пока не подключать к UI.
- 0.2 Ввести feature-flag `VITE_SSOT_SDK` (или runtime-флаг), позволяющий переключать источник чтения (Dexie ↔ SDK) по модулям. Это даст постепенную миграцию и быстрый откат.
- 0.3 Инвентаризация «мёртвого» кода Dexie (удалить сразу, безопасно):
  - `EventWriter.saveSyncToken/getSyncToken/getLastSyncAt` — нет прод-вызовов.
  - `UserRepository.upsertUser/bulkUpsertUsers/getStaleUsers/deleteUser` — только тесты.
  - `EventWriter`-инъекция `userRepo` — не используется.
  - `ListenedRepository.getListenedSet` — нет прод-вызовов.
  - Pcrypto `messages:{address}` (`ls`) и `files`-init в matrix-client, если решено не использовать `ls`.

**Тесты:** `use-matrix-live-query.test.ts`.
**Выход:** инфраструктура готова, ничего в UI не сломано.

### Фаза 1 — Мелкие таблицы (Low risk, быстрые победы)

Убираем таблицы, не влияющие на ядро ленты.

- 1.1 **`callProviders` → localStorage.** Заменить `CallProvidersRepository` на localStorage-хранилище (device-only, несколько строк). Обновить `CallProvidersSection.vue`, `ChatWindow.vue:307`, `use-call-launcher.ts`. Реактивность — обычный Pinia ref (не `useLiveQuery`).
- 1.2 **`listenedMessages` → Matrix account_data или localStorage.** `VoiceMessage.vue`, `ChatWindow.vue:65`. Set id небольшой; account_data даёт кросс-девайс синк «прослушано».
- 1.3 **`syncState.device_telemetry` → localStorage.** `app/providers/index.ts:80`, `SettingsContentPanel.vue:48`. Убрать `useLiveQuery`.
- 1.4 **`searchCache` → in-memory + (опц.) ResoursesDB storage.** `use-contacts.ts:115-184`. TTL-кэш поиска.

**Тесты:** обновить/заменить соответствующие тесты (`call-providers-repository.test.ts` → localStorage-версия и т.д.).
**Выход:** −4 таблицы Dexie, UI не деградирует.

### Фаза 2 — Channels → pSDK (Medium)

- 2.1 Решить механизм кэша channels в `psdk_production`:
  - **2a:** добавить объект-стор `channels` в `dbmeta` (`public/js/lib/client/sdk.js`) + метод `psdk.channels.load/get` поверх `getsubscribeschannels`. Тогда cold-start читает из ResoursesDB (сохраняем WEE-24 мгновенный рендер).
  - **2b:** in-memory Pinia + один RPC при входе (проще, но теряем мгновенный cold-start → нужно UX-смягчение: скелетон/последняя сессия в localStorage).
- 2.2 Переписать `channel-store.ts:147-333`: `hydrateFromDexie` → `hydrateFromPsdk`. Удалить `ChannelRepository`.
- 2.3 Проверить `ChatSidebar.vue`, `ChannelList.vue`, `ChannelView.vue`.

**Регресс-риск:** пустой список каналов на холодном старте (WEE-24). Митигация: localStorage-снапшот последнего списка.
**Тесты:** `channel-store` cold-start из pSDK; регрессионный на «нет пустого сайдбара».
**Выход:** −1 таблица (`channels`), channels живут в pSDK.

### Фаза 3 — Users/aliases → pSDK + account_data (Medium)

- 3.1 Профили: подтвердить, что все чтения профилей идут через `userStore`/`psdk.userInfo` (уже так). Убрать любые остаточные записи в Dexie `users`.
- 3.2 Алиасы: перенести чтение/запись `localAlias` c Dexie `users` на Matrix account_data `m.bastyon.contact_aliases` (механизм синка уже существует). Заменить `readUserAliases()` (`index.ts:273`) и `users.getAllAliases/setAlias` (`chat-store.ts:753-810, 6871`).
- 3.3 Bootstrap алиасов на холодном старте (`App.vue` `hydrateLocalAliasesEarly`) — из localStorage-снапшота account_data (до Matrix init).

**Регресс-риск:** алиасы не показываются до первого /sync. Митигация: localStorage-снапшот.
**Тесты:** LWW-разрешение алиасов из account_data; cold-start.
**Выход:** −1 таблица (`users`).

### Фаза 4 — Media cache → files/Capacitor (High)

- 4.1 Реализовать `MediaCacheStorage` поверх Pcrypto `files` (web) + Capacitor FS (native), с LRU-индексом в localStorage (или метаданными в `files`-IDB). Сохранить публичный API `getMediaCache()` чтобы не трогать потребителей.
- 4.2 Отвязать `src/shared/lib/media-cache/` от `ChatDatabase` (`initMediaCache(db)` → `initMediaCache()` без Dexie).
- 4.3 Перенести `attachments` (upload-пайплайн) на новый слой; связать с send-путём (Фаза 6).
- 4.4 Обновить Storage-настройки (`StorageSettings.vue`, `ChatStorageDetail.vue`, `StoragePreview.vue`, `use-media-thumbnails.ts`) — breakdown по roomId/category теперь из нового индекса.

**Регресс-риск:** потеря per-chat breakdown (Telegram-style) если индекс упростить. Решить: хранить roomId/category в метаданных `files`.
**Тесты:** media-cache put/get/LRU/clear на новом слое; Storage UI.
**Выход:** −2 таблицы (`mediaCacheIndex`, `mediaCacheBlobs`), media в `files`.

### Фаза 5 — Reactive room list из SDK (Critical)

- 5.1 Построить `sortedRooms`/sidebar из SDK: `client.getRooms()` + `room.currentState` + `room.getUnreadNotificationCount` + accountData, вместо `dexieRoomMap`/`observeRoomChanges`.
- 5.2 Derived-поля: `lastMessagePreview` (из последнего события таймлайна + Pcrypto decrypt), unread (watermark в account_data / SDK receipts), tombstone (membership `leave`), aliases (Фаза 3), stream-room фильтр (`historyVisibility`).
- 5.3 Реактивность: `useMatrixLiveQuery` на `Room.timeline`, `Room.name`, `Room.Receipt`, `RoomState.events`, `Room.MyMembership`, `accountData`.
- 5.4 Удалить `RoomRepository`, `room-repository` часть `EventWriter`.

**Регресс-риск:** высокий — sidebar это самый «горячий» путь; перф на 100+ комнатах (см. `room-list-scalability`). Нужен бенч.
**Тесты:** sidebar сортировка/preview/unread из SDK; перф-тест на большом аккаунте.
**Выход:** −1 таблица (`rooms`), sidebar на SDK.

### Фаза 6 — Send path на SDK local echo (Critical)

- 6.1 Включить `pendingEventOrdering: "detached"` (matrix-client опции). Проверить, что не ломает существующий live-echo merge.
- 6.2 Переписать `use-messages.ts`: `createLocal` (Dexie) → `client.sendEvent(...,txnId)`; optimistic из `room.getPendingEvents()`.
- 6.3 Outbound-очередь: заменить `SyncEngine` FIFO/backoff на SDK-планировщик + сохранить **кастомный media-пайплайн** (encrypt→upload→send) как обёртку (SDK не делает Pcrypto-encrypt).
- 6.4 Cross-session pending: SDK хранит pending в localStorage (`mx_pending_events_{roomId}`) — проверить достаточность vs текущего durable `pendingOps`.
- 6.5 Статусы sending/failed/retry в UI — из `EventStatus` + `Room.LocalEchoUpdated`.
- 6.6 Удалить `SyncEngine`, `pendingOps`, `attachments` (media-часть переносится в 6.3).

**Регресс-риск:** очень высокий — это ядро надёжной доставки (WEE-94/105, весь план `2026-06-30-android-chat-open-send-fix.md`). Обязательный флаг + канареечный откат.
**Тесты:** оффлайн-отправка, retry после reconnect, media-пайплайн, дедуп txnId, cross-session pending.
**Выход:** −2 таблицы (`pendingOps`, `attachments`), отправка на SDK.

### Фаза 7 — Message timeline из SDK + Pcrypto (Critical, финал)

- 7.1 Заменить `activeMessages` (`useLiveQuery`→`messages.getMessages`) на чтение из `room.getLiveTimeline().getEvents()` + пагинация `paginateEventTimeline`/`scrollback`, decrypt через Pcrypto (memo в `events`-кэше).
- 7.2 Реактивность ленты через `useMatrixLiveQuery` (`Room.timeline`, `Room.Redaction`, edits/reactions).
- 7.3 Реакции/редакции/поллы: использовать SDK relation API (`EventTimelineSet#getRelationsForEvent`, `getServerAggregatedRelation`) вместо ручной агрегации в Dexie, либо перенести ручную агрегацию в in-memory поверх SDK.
- 7.4 Расшифровка-retry: `decryptionQueue` (Dexie) → in-memory очередь + Pcrypto `events`-кэш; `[encrypted]`-плейсхолдеры и refresh-кнопка — из состояния события, не из Dexie.
- 7.5 Clear-history/tombstone/watermarks — из Matrix account_data (`m.bastyon.clear_history`, receipts).
- 7.6 Пагинация/виртуальный скролл (`ChatVirtualScroller`, `MessageList.vue`, `use-scroll-to-message.ts`) — на SDK-таймлайн.
- 7.7 Удалить `MessageRepository`, `EventWriter`, `DecryptionWorker`, `WriteBuffer`, `mappers`, `timeline-sort`, `use-live-query`, `schema`, весь `src/shared/lib/local-db/`.

**Регресс-риск:** максимальный — это read path открытия чата (WEE-95/97, весь android-план). Нужны e2e (Maestro, см. `2026-06-30-maestro-android-e2e.md`).
**Тесты:** лента/пагинация/scroll-to-message/reactions/edits/redactions/clear-history; decrypt-retry; e2e Android.
**Выход:** Dexie удалён полностью.

### Фаза 8 — Очистка

- 8.1 Удалить `dexie` из `package.json`, `fake-indexeddb` (если только для Dexie-тестов).
- 8.2 Удалить `deleteChatDb`/`closeChatDb`/`initChatDb` из auth-флоу (`stores.ts:18,455-489,1270-1271,1886`), заменить на очистку SDK-стора/Pcrypto/pSDK при logout.
- 8.3 Обновить `AppLoading.vue` clear-and-retry (удаление IndexedDB баз — список имён меняется).
- 8.4 Обновить `docs/local-first-architecture.md` (переписать под новую архитектуру), `CLAUDE.md`, `README`.
- 8.5 Удалить legacy `bastyon-chat-cache` (`chat-cache.ts`) окончательно.

---

## 5. Матрица рисков

| Риск | Фаза | Вероятность | Импакт | Митигация |
|------|------|-------------|--------|-----------|
| Offline-история неполная (SDK не персистит scrollback) | 7 | Высокая | Высокий | Pcrypto `events`-кэш как memo; принять «offline = кэшированное» (совпадает с текущим поведением наполнения из scrollback) |
| Регресс надёжной отправки (WEE-94/105) | 6 | Высокая | Критический | Feature-flag, канареечный rollout, сохранить media-пайплайн, e2e |
| Перф sidebar на 100+ комнат | 5 | Средняя | Высокий | Бенчмарк до/после, инкрементальные обновления через events |
| Пустой список каналов на cold-start (WEE-24) | 2 | Средняя | Средний | localStorage-снапшот / ResoursesDB storage |
| Потеря durable decryptionQueue между рестартами | 7 | Средняя | Средний | Pcrypto memo + повторная расшифровка из SDK-события |
| Потеря per-chat media breakdown | 4 | Низкая | Низкий | Метаданные roomId/category в `files`-индексе |
| `unstableClientRelationAggregation` — no-op на форке | 7 | Средняя | Средний | Проверить фактическую агрегацию relations в `matrix-js-sdk-bastyon@23.2.x` |
| Огромный тестовый долг (40+ файлов `local-db/__tests__`) | все | Высокая | Средний | Переписывать тесты по фазам вместе с кодом |

---

## 6. Открытые вопросы (требуют решения до старта)

1. **Offline-глубина истории:** принимаем ли B1a (история по требованию из сети + Pcrypto-кэш) как «offline-first», или требуется полная offline-история (тогда Dexie де-факто не убирается, а заменяется своим persist-слоем)?
2. **Channels:** трогаем ли вендорный `public/js/lib/client/sdk.js` (добавить storage в ResoursesDB) — это Bastyon-платформенный скрипт, правки могут конфликтовать с апстримом.
3. **Send-очередь:** достаточно ли SDK localStorage-pending vs текущего durable `pendingOps` для гарантий доставки на Android после kill процесса?
4. **Relations:** поддерживает ли форк `matrix-js-sdk-bastyon` серверную агрегацию reactions/edits, или ручная агрегация остаётся (тогда её нужно держать in-memory)?
5. **E2EE-invariant:** Pcrypto остаётся внешним; SDK-crypto не включаем. Подтвердить, что decrypt-on-render не убьёт перф на слабых Android (иначе нужен durable plaintext = Dexie-подобный слой).

---

## 7. Оценка объёма (грубо)

| Фаза | Модулей затронуто | Относительный объём |
|------|-------------------|---------------------|
| 0 Фундамент | 3-5 | S |
| 1 Мелкие таблицы | ~8 | S-M |
| 2 Channels | ~5 (+ вендор) | M |
| 3 Users/aliases | ~6 | M |
| 4 Media | ~8 | M-L |
| 5 Room list | ~10 (chat-store ядро) | L |
| 6 Send path | ~10 (критическое ядро) | XL |
| 7 Timeline | ~20 (chat-store + messaging + local-db удаление) | XL |
| 8 Очистка | ~10 + docs | M |

**Итог:** это программа на несколько крупных этапов, а не одна задача. Рекомендуемый минимальный безопасный срез для быстрой ценности — **Фазы 0-4** (убирают 9 из 13 таблиц без риска для ядра ленты/отправки). Фазы 5-7 (ядро) требуют отдельного решения по открытым вопросам §6.

---

## Приложение A — Полный инвентарь потребителей Dexie

См. детальный отчёт ресёрча: каждая таблица, её reader/writer-модули и UI-зависимости задокументированы в исследовании (chat-store как центральный хаб, `use-messages`, `MessageList`, sidebar, media-cache, channels, contacts). Ключевые точки интеграции:

- **Bootstrap/lifecycle:** `src/entities/auth/model/stores.ts` (init/delete/close ChatDb), `src/app/providers/index.ts` (telemetry), `src/app/App.vue` (early aliases).
- **Центральный хаб:** `src/entities/chat/model/chat-store.ts` — использует весь `ChatDbKit`; главная точка Matrix→Dexie→UI.
- **Messaging:** `use-messages.ts`, `MessageList.vue`, `use-scroll-to-message.ts`, `use-file-download.ts`, `VoiceMessage.vue`.
- **Channels:** `src/entities/channel/model/channel-store.ts`.
- **Contacts/search:** `src/features/contacts/model/use-contacts.ts`.
- **Settings/storage:** `StorageSettings.vue`, `ChatStorageDetail.vue`, `StoragePreview.vue`, `use-media-thumbnails.ts`, `CallProvidersSection.vue`.
- **Widgets:** `ChatWindow.vue`, `SettingsContentPanel.vue`.

## Приложение B — Ключевые файлы SDK/Pcrypto/pSDK

| Тема | Путь |
|------|------|
| SDK-клиент, IndexedDBStore, sync-фильтр | `src/entities/matrix/model/matrix-client.ts:237-347` |
| SDK persist (backend) | `node_modules/matrix-js-sdk-bastyon/src/store/indexeddb-local-backend.ts` |
| SDK scrollback/memory no-op | `node_modules/matrix-js-sdk-bastyon/src/store/memory.ts:210-223` |
| SDK sync-accumulator (~50 событий) | `node_modules/matrix-js-sdk-bastyon/src/store/sync-accumulator.ts:35-216` |
| Pcrypto (encrypt/decrypt/keys) | `src/entities/matrix/model/matrix-crypto.ts` |
| Pcrypto IDB-кэш (`events`/`messages`/`files`) | `src/shared/lib/matrix/chat-storage.ts` |
| pSDK создание `psdk_production` | `public/js/lib/client/sdk.js:143` + `resoursesdb.js` |
| pSDK userInfo/channels | `src/app/providers/initializers/app-initializer.ts:358-435,879-909` |
| Pocketnet RPC (failover) | `src/shared/lib/pocketnet/node-rpc-client.ts`, `node-failover.ts` |
| Dexie schema (что убираем) | `src/shared/lib/local-db/schema.ts` |
| Dexie реактивность | `src/shared/lib/local-db/use-live-query.ts`, `room-repository.ts:685-724` |
