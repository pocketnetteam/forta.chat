# AI-чаты в Forta Chat поверх библиотеки `local-ai`

**Дата:** 2026-08-11
**Источник библиотеки:** `C:\inetpub2026\localai` (локально, не опубликована в npm — `package.json`: `"name": "local-ai"`, `"version": "0.0.0"`, `"private": true`, `"license": "UNLICENSED"`)
**Статус:** черновик плана интеграции, готов к разбивке на фазы (см. [roadmap](./2026-08-11-local-ai-integration-roadmap.md))

> Этот документ описывает, как подключить уже написанную библиотеку `local-ai` (офлайн-LLM-инференс
> через `llama-cpp-capacitor`) к Forta Chat как новую группу чатов «AI» — отдельно от Matrix-чатов,
> без переиспользования Matrix/SyncEngine/шифрования. Сама библиотека не документируется здесь заново —
> см. `C:\inetpub2026\localai\README.md` и `docs/2026-08-10-local-ai-library-tz.md` для полного ТЗ.

---

## 1. Что уже есть в `local-ai` (кратко)

Библиотека — TS-пакет с hexagonal-архитектурой (`core/` не знает про Capacitor, только порты;
`adapters/capacitor/` и `adapters/node-testing/` — конкретные реализации). Даёт:

1. Одну LLM-модель (~4B, Q4_K_M, мультиязычная) + одну embedding-модель, обе версионируются
   **независимо** через JSON-манифест (`LocalAiConfig.manifestUrl`).
2. Resumable-скачивание модели с Hugging Face (pinned revision) и эмбеддинга по произвольному
   HTTPS-URL, через `@capgo/capacitor-downloader`, с прогрессом и sha256-проверкой.
3. `checkSupport()` — программная проверка «доступна ли библиотека вообще» (платформа + нужные
   нативные плагины зарегистрированы) — **до** любой сети/памяти.
4. `checkDeviceEligibility()` — проверка RAM/диска/термики конкретного устройства под конкретную
   модель из манифеста (`'ok' | 'tight' | 'no' | 'unknown'`), без хардкод-тиров.
5. Собственную SQLite-БД внутри себя (чаты, история сообщений, download-state, векторный стор) —
   **но** с явным «Mode B»: библиотека может работать как чистое хранилище контекста для модели,
   зеркаля чужую историю по совпадающим `id`, не будучи источником истины для UI (см. §3 ниже).
6. Множество независимых диалогов поверх одной загруженной модели, стриминг токенов
   (`for await (const token of stream)` + `await stream.result`), session-cache (KV-кеш модели) для
   быстрого повторного ответа в том же чате, политику усечения контекстного окна, явную семантику
   отмены/ошибки генерации (`status: 'complete'|'cancelled'|'error'`).
7. Управление памятью (`releaseRuntime()`, опциональный auto-unload при уходе в фон).
8. embedding + примитив векторного поиска (`vectors.upsert/search`) — **не используется** в этой
   интеграции (см. §6 «Эмбеддинги — не в этой фазе»).
9. **Локальное логирование + экспорт** (добавлено 2026-08-11, после первой версии этого плана —
   см. §12): пробрасываемый `logger`-колбэк (не персистентный, TZ §14) плюс отдельный **опциональный**
   персистентный лог-стор в SQLite (`config.logging.enabled`, по умолчанию `false`) с
   `client.exportLogs()`/`client.clearLogs()`. Оба механизма независимы друг от друга.

**Статус реализации самой библиотеки** (`ROADMAP.md`, `docs/decisions.md`): Фазы 0–8 (включая большую
часть post-v1 объёма Фазы 8) + security-hardening + «Local logging & export» пройдены, **222**
автотеста зелёных (Node: unit/integration/contract, было 200 на момент первой версии этого плана).
**Но** всё, что реально трогает
нативный мост (`llama-cpp-capacitor`, `@capacitor-community/sqlite`'s `loadExtension`,
`@capgo/capacitor-downloader`, `@capgo/capacitor-device-info`), написано «по реальному API плагина»,
но **ни разу не запускалось на реальном Android/iOS-устройстве** — в среде разработки библиотеки не было
девайса/эмулятора. Это прямо и честно задокументировано в её собственном README и в каждом ADR
(`proposed`, не `accepted`). **Для forta.chat это значит: первая фаза интеграции обязана включать
ручной smoke-тест на реальном Android-устройстве, а не доверять «зелёным тестам» библиотеки как
доказательству работы на телефоне.**

---

## 2. Архитектурное решение: Dexie — источник истины, `local-ai` — память модели

Проектное правило (`CLAUDE.md`): **Dexie = single source of truth**, все данные читаются через
`useLiveQuery`. Библиотека `local-ai` в своём ТЗ прямо предусматривает этот сценарий и называет его
**Mode B** («библиотека как контекст-зеркало», `docs/guides/mode-b-integration.md`,
ТЗ §9.6) — специально для приложений, у которых уже есть своя история чатов и своё UI:

| | Владелец истины | Кто рисует UI |
|---|---|---|
| **Mode A** (не используем) | `local-ai`'s SQLite | нет UI в библиотеке |
| **Mode B** (используем) | Dexie (`ChatDatabase`, эта интеграция) | Forta Chat |

`local-ai` в Mode B **не подменяет** Dexie — он только копит ту же историю под теми же `id`, чтобы
строить контекст для модели (промпт, session-cache). Три вызова, которые это делают
(`docs/guides/mode-b-integration.md`):

```ts
// 1. Чат уже создан в Dexie → зеркалим в local-ai по тому же id (идемпотентно)
await client.upsertChat({ id: chat.id, title: chat.title });

// 2. Дозаливаем историю (безопасно вызывать повторно — дубликаты по id молча пропускаются)
await client.appendMessages(chat.id, historyFromDexie);

// 3. Новое сообщение — id генерируем МЫ (совпадают в Dexie и в local-ai)
const stream = client.sendMessage(chat.id, text, {
  userMessageId: localUserMsg.id,
  assistantMessageId: localAssistantMsg.id,
  signal: abortController.signal,
});
for await (const token of stream) { /* обновляем реактивный буфер в Pinia */ }
const finalMsg = await stream.result; // status: complete | cancelled | error
// пишем finalMsg.content/status в Dexie — Dexie остаётся тем, что видит пользователь
```

**Не заливать полную историю на каждый `sendMessage`.** `appendMessages` идемпотентен (dedup по
`chatId+id`), но вызывать его с **полной** историей чата перед каждым сообщением — это N
insert-with-conflict-check на каждую отправку в длинном диалоге, а не только на реально новые записи.
Дешевле держать high-water mark (например `lastSyncedMessageId`/count в `LocalAiChat` или просто
локальный in-memory Set в сторе на время сессии) и доливать в `local-ai` только то, что ещё не
доливалось — один полный `appendMessages` при **первом** открытии/создании чата в сессии, дальше
только дельта. См. roadmap 3.3.

**Гайд библиотеки `docs/guides/mode-b-integration.md` устарел в одном месте.** Он пишет, что
редактирование/удаление отдельных уже сохранённых сообщений «doesn't exist yet (TZ §16, post-v1)» —
это верно для состояния библиотеки **до** Фазы 8, но не сейчас: `ConversationSyncApi.updateMessage()`/
`deleteMessages()` уже реализованы (`src/core/client/local-ai-client.ts:707-725` в `local-ai`,
`docs/decisions.md` #7a) именно для Mode B-синка правок/удалений отдельных сообщений из БД
приложения-хозяина. В этом плане они пока не нужны (assistant-сообщения в v1 не редактируются
пользователем), но если Фаза 3/7 когда-нибудь коснётся редактирования/удаления отдельного AI-сообщения
(а не всего чата) — метод уже есть в библиотеке, ориентироваться на актуальный код `local-ai-client.ts`,
а не на этот гайд.

**Почему не просто `complete()` без чатов вообще (полностью своя сборка промпта)?** Потому что тогда
пришлось бы заново реализовать то, что `local-ai` уже даёт и тестирует: политику усечения контекстного
окна (`contextStrategy`/`maxContextTokens`, ТЗ §9.7), session-cache (переиспользование KV-кеша модели —
ощутимо быстрее второй ответ в том же чате, ТЗ §9.3), точный подсчёт токенов через настоящий токенайзер
модели, семантику отмены/ошибки. Дублировать это в Forta Chat — работа впустую и риск разъехаться
с тем, что реально тестировано в библиотеке. Цена Mode B — два комплекта данных на диске (Dexie +
внутренняя SQLite `local-ai`), но `local-ai`'s копия **невидима** пользователю и командам разработки —
это деталь реализации рантайма модели, а не конкурирующий источник истины.

### 2.1 Где живут данные

| Что | Где | Почему |
|---|---|---|
| Список AI-чатов, отображаемых в сайдбаре | Dexie `aiChats` (новая таблица, та же `ChatDatabase`) | source of truth, `useLiveQuery` |
| Сообщения AI-чата, отображаемые в UI | Dexie `aiMessages` (новая таблица) | source of truth |
| Зеркало тех же чатов/сообщений для построения промпта | `local-ai`'s внутренняя SQLite (`installed` через `CapacitorSqliteAdapter`) | требуется самой библиотекой для `sendMessage`/session-cache/context-policy |
| Файл модели (.gguf) | `local-ai`'s `storageDirectory` (Filesystem) | общий для всех аккаунтов на устройстве (см. §5) |
| Прогресс загрузки/eligibility/статус модели | Pinia-стор в памяти (не Dexie) — см. §4 | эфемерное состояние текущей сессии |

---

## 3. Новые таблицы в `ChatDatabase` (та же Dexie-база, не отдельная БД)

Важное следствие: `ChatDatabase` уже создаётся **на пользователя**
(`new ChatDatabase(userId)` → `bastyon-chat-${userId}`, `src/shared/lib/local-db/schema.ts:332`).
Если положить `aiChats`/`aiMessages` в неё же, а не в отдельную БД — logout/переключение аккаунта уже
изолирует и чистит AI-чаты **бесплатно**, тем же механизмом, что и Matrix-комнаты (`closeChatDb()`/
`deleteChatDb()` из `initChatDb()`/`closeChatDb()`/`deleteChatDb()` lifecycle). Отдельная БД потребовала
бы дублировать эту логику вручную — не делаем.

```ts
// src/shared/lib/local-db/schema.ts — новые интерфейсы + version(18)

export type AiMessageStatus = "pending" | "streaming" | "complete" | "cancelled" | "error";

export interface LocalAiChat {
  id: string;                 // UUID, сгенерирован локально; тот же id уходит в local-ai.upsertChat()
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview?: string;
  lastMessageTimestamp?: number;
  /** id модели (LocalAiManifest.model.id), под которую собрана история чата — для UI/дебага,
   *  не участвует в логике library (та сама знает текущую модель через ModelRegistry). */
  modelId?: string;
}

export interface LocalAiMessage {
  localId?: number;           // Dexie auto PK
  id: string;                 // UUID; тот же id уходит как userMessageId/assistantMessageId
  chatId: string;             // FK → LocalAiChat.id
  role: "user" | "assistant"; // system-сообщения не рендерятся, не храним в UI-таблице
  content: string;
  status: AiMessageStatus;
  createdAt: number;
  tokenCount?: number;
}
```

```ts
// ChatDatabase — version(18) добавляет обе таблицы, схема предыдущих версий копируется как есть
this.version(18).stores({
  // ...все существующие таблицы без изменений...
  aiChats: "id, updatedAt",
  aiMessages: "++localId, id, [chatId+createdAt]",
});
```

Новые репозитории — `src/shared/lib/local-db/ai-chat-repository.ts` и
`src/shared/lib/local-db/ai-message-repository.ts`, по образцу `channel-repository.ts`
(`getAll`/`bulkUpsert`/`replaceAll` — простые CRUD-обёртки над Dexie-таблицей, без SyncEngine, без
шифрования, без event-writer — эти концепции специфичны для Matrix-конвейера и AI-чатам не нужны).

---

## 4. Жизненный цикл `LocalAiClient` — новый слой `entities/local-ai`

По образцу `entities/channel` (стор + типы + lib), но роль другая: `entities/channel` — это данные,
`entities/local-ai` — это **владелец рантайма модели** (создание/уничтожение `LocalAiClient`,
подписка на его события, эфемерное состояние загрузки).

```text
src/entities/local-ai/
  model/
    local-ai-store.ts     # Pinia-стор: client, supportReport, eligibilityReport,
                           # downloadState (model/embedding progress), modelReady, initError
    types.ts
  lib/
    create-client.ts       # сборка LocalAiPorts из Capacitor-адаптеров (см. §5), per-account databaseName
  index.ts
```

`useLocalAiStore()` отвечает на два вопроса, которые нужны и Settings, и чату:
«готова ли модель прямо сейчас» и «идёт ли сейчас загрузка/обновление и с каким процентом» — **одно**
состояние, оба экрана на него подписываются (`useLiveQuery`-подобный реактивный доступ через Pinia,
без дублирования опроса).

Ключевые методы стора:

- `ensureClient()` — ленивая инициализация `LocalAiClient.create({...})` с Capacitor-адаптерами;
  вызывается **один раз за сессию**, только когда: `isNative === true` **и** пользователь либо открыл
  Settings → Local AI, либо создал/открыл AI-чат (см. §4.1 — модель не качаем эагерно на старте
  приложения).
- `checkSupportOnce()` — обёртка над `LocalAiClient.checkSupport()`, не требует `create()`; вызывается
  до показа пункта «AI» в сайдбаре вообще (см. §7).
- `refreshManifest()`, `checkEligibility()`.
- `downloadModel()` — `ensureModelReady({ onProgress })`, пишет прогресс в `downloadState.model`.
  **Явно не вызывает `ensureEmbeddingReady()`/`ensureReady()`** — см. §6.
- `releaseRuntime()` — вызывается на logout/переключение аккаунта (симметрично `closeChatDb()`), и
  опционально на `autoUnloadOnBackground` (см. §8.3).

### 4.1 Когда модель реально качается

Требование пользователя: «Модель скачивается не сразу, а либо из настроек, либо когда создаешь чат
с AI». Реализация:

1. Создание AI-чата (`aiChatStore.createChat()`) **не** блокируется на загрузку модели — чат создаётся
   в Dexie мгновенно, пустой, и открывается.
2. Открытый AI-чат без готовой модели показывает пустое состояние с кнопкой «Скачать модель»
   (не автозапуск!) — первое **сообщение** пользователь ещё не может отправить, но сам чат уже существует
   и виден в списке. Явный клик — то же самое действие, что и кнопка в Settings (§4 `downloadModel()`),
   один и тот же стор, один и тот же прогресс-бар.
   - Альтернатива — автозапуск загрузки по первому сообщению без лишнего клика — тоже разумна и ближе к
     ChatGPT-подобному UX; финальное решение — открытый вопрос продукта (см. §9, П.5).
3. Settings → Local AI: та же кнопка «Скачать/Обновить модель», доступна без захода в чат.

### 4.2 Мультиаккаунт

В Forta Chat есть переключение аккаунтов на одном устройстве (`AccountList` в `SettingsPanel.vue`).
`local-ai`'s внутренняя SQLite-БД **обязана** быть на аккаунт (иначе история/контекст AI-чата одного
пользователя утечёт в промпт другому при переключении) — `CapacitorSqliteAdapter` принимает
`databaseName` в конструкторе, поэтому адаптер пересобирается при смене активного адреса:
`databaseName: local_ai_${addressHash}`. Файл **модели** (.gguf) при этом **общий** для всех аккаунтов
на устройстве — контент-адресован именем с версией (`model__<id>__v<version>.gguf`), качать его повторно
на каждый аккаунт бессмысленно; `storageDirectory` для файлов моделей остаётся общим, разделяется только
`databaseName` (SQLite: чаты-зеркало, download-state, kv_store, eligibility-вердикты).

---

## 5. Нативный слой: чего не хватает

`local-ai` — `peerDependencies` (все `optional: true`, но фактически обязательны для реального инференса):

```
@capacitor-community/sqlite  >=8.0.0
@capacitor/app                >=8.0.0   ✅ уже установлен (8.0.1)
@capacitor/core                >=8.0.0   ✅ уже установлен (8.2.0)
@capacitor/filesystem          >=8.0.0   ✅ уже установлен (8.1.2)
@capgo/capacitor-device-info   >=8.0.0   ❌ нет
@capgo/capacitor-downloader    >=8.0.0   ❌ нет
llama-cpp-capacitor            >=0.1.5   ❌ нет
```

Значит нужно добавить **три** новых нативных плагина + сам `local-ai`. Каждый — это
`npm install` + `npx cap sync android` + (для iOS, если делаем) `npx cap sync ios` + рост размера
APK/IPA за счёт нативных бинарников `llama.cpp` под все целевые ABI.

**Установка самой `local-ai`, пока она не в npm:** библиотека объявляет
`"private": true, "license": "UNLICENSED"` и не опубликована. До публикации — локальная
file-зависимость:

```jsonc
// forta.chat/package.json
"dependencies": {
  "local-ai": "file:../../inetpub2026/localai"
}
```

Требует предварительного `pnpm build` внутри `C:\inetpub2026\localai` (генерирует `dist/`, которого
package.json ожидает через `exports`/`main`/`types`) — `npm install` не пересобирает чужой пакет сам.
После публикации в npm — заменить на версию из реестра, без изменения кода потребителя (subpath-экспорты
(`local-ai`, `local-ai/adapters/capacitor`) остаются теми же).

### 5.1 minSdk / Android 7 совместимость — открытый риск

Текущий проектный контекст (`CLAUDE.md`): Android 7.0+ (minSdk 24), цель — одинаковая стабильность на
всех поддерживаемых устройствах. ТЗ `local-ai` пишет про `llama-cpp-capacitor`: «minSdk по требованиям
native-плагина инференса, обычно 24+» — **не подтверждено измерением**, только ссылкой на «обычно».
Отдельно от minSdk есть более острый риск: **ABI/производительность**. 4B Q4_K_M модель на
слабом/старом Android 7 устройстве (часто 32-бит ARM или ограниченная RAM) с высокой вероятностью либо
не запустится (`eligibilityVerdict: 'no'` по RAM), либо будет мучительно медленной
(`tooSlow`-вердикт из `bench()`, ТЗ §6.3). Библиотека это **предвидела и спроектировала защиту**
(`checkSupport()` + `checkDeviceEligibility()` + `eligibilityPolicy: { no: 'block' }` по умолчанию) —
наша задача — не обходить эту защиту и явно показывать «на этом устройстве AI недоступен» вместо
попытки принудительно запустить. Это прямое продолжение цели Android-аудита проекта: не одинаковая
*производительность* AI на всех устройствах (нереалистично для 4B LLM), а одинаково **корректная,
не ломающая остальное приложение** деградация там, где AI объективно не потянет.

---

## 6. Эмбеддинги — не в этой фазе

Пользователь: «Эмбедингов еще нет». Манифест `LocalAiManifest` **обязателен** для поля `embedding`
(TS-тип не делает его опциональным, `manifest.service.ts` валидирует оба артефакта разом) — то есть
манифест **должен** содержать валидный embedding-артефакт, даже если приложение никогда не скачивает
и не использует его. План:

- Манифест публикуется с реальным (небольшим) embedding-артефактом для прохождения валидации схемы
  (например `bge-small`-класс, как в примере `docs/guides/manifest-format.md`), но
  - **приложение никогда не вызывает** `ensureEmbeddingReady()` / `ensureReady()` (тот, что качает оба
    сразу) / `client.vectors.*` — только `ensureModelReady()`.
  - Файл эмбеддинга **не скачивается** ни при каких действиях пользователя в этой фазе.
- RAG / knowledge packs / поиск по истории через embedding — отдельный план, **после** закрытия этой
  интеграции, по прямой аналогии с тем, как старый `docs/plans/llama/2026-08-08-local-ai-knowledge-rag-plan.md`
  был явно заблокирован до закрытия основного плана. См. roadmap, Фаза R (заблокирована).

---

## 7. UI: сайдбар — вкладка «AI»

Точный прецедент в кодовой базе — вкладка **Channels** (`entities/channel` + `features/channels`):
отдельный локальный источник данных, не Matrix-комната, свой пункт в `activeFilter`
(`src/widgets/sidebar/ChatSidebar.vue:70`), свой `<template #channels>` в `SwipeableTabs`,
авто-скрытие вкладки когда данных нет (`src/widgets/sidebar/ChatSidebar.vue:129,165-173`). AI-вкладку
строим по тому же шаблону — **новый** `entities/ai-chat` (Pinia-стор над `aiChats`/`aiMessages`,
`useLiveQuery`) + **новый** `features/ai-chat` (UI), не трогая существующий Matrix-конвейер
(`chat-store.ts`, `room-repository.ts`, `sync-engine.ts` и т.д. не меняются).

```
src/entities/ai-chat/
  model/
    ai-chat-store.ts   # useLiveQuery(aiChats), createChat/renameChat/deleteChat/sendMessage/cancel
    types.ts
  lib/
  index.ts

src/features/ai-chat/
  ui/
    AiChatList.vue      # аналог ChannelList.vue
    AiChatView.vue       # аналог ChannelView.vue — но с composer'ом и стримингом
    AiModelGate.vue       # общий "модель не готова / качается / eligibility-блок" виджет —
                            # переиспользуется и в AiChatView, и в Settings (§8)
  index.ts
```

### 7.1 Видимость вкладки

В отличие от Channels (вкладка скрыта, пока нет подписок), AI — заявленная фича продукта, должна быть
обнаруживаемой. Но библиотека принципиально не работает на web/Electron
(`capabilities.inference === false`, инференс требует native + `llama-cpp-capacitor`). Правило:

```ts
const visibleTabValues = computed(() => {
  const tabs: string[] = ["all", "personal", "groups"];
  if (chatStore.inviteCount > 0) tabs.push("invites");
  if (channelStore.channels.length > 0) tabs.push("channels");
  if (isNative) tabs.push("ai"); // checkSupport() уточняет ПОЧЕМУ недоступно уже ВНУТРИ вкладки —
                                   // саму вкладку прячем сразу и дёшево по isNative, не дожидаясь
                                   // асинхронного checkSupport()
  return tabs;
});
```

Внутри вкладки (`AiChatList.vue`/`AiModelGate.vue`) — уже настоящий `checkSupport()` (плагин может не
быть зарегистрирован даже на native-сборке, например forgot `cap sync`) и `checkDeviceEligibility()`
с понятным объяснением, не просто «недоступно».

### 7.2 Кнопка «новый чат»

Сейчас в шапке сайдбара один и тот же «New Group» (user-plus) для любой активной вкладки
(`ChatSidebar.vue:261-282`, `emit('newGroup')`). Делаем кнопку контекстной по `activeFilter`:

```html
<button v-if="activeFilter === 'ai'" @click="handleNewAiChat" :title="t('ai.newChat')">
  <!-- иконка "plus" / "message-square-plus" -->
</button>
<button v-else :title="t('nav.newGroup')" @click="emit('newGroup')">
  <!-- существующая user-plus иконка -->
</button>
```

`handleNewAiChat` — `aiChatStore.createChat()` (мгновенно, без модалки — «начать новый чат» буквально
по формулировке задачи, как в ChatGPT) → сразу открыть созданный чат (`emit('selectRoom')`-подобно
существующему потоку `handleRoomCreated`).

### 7.3 Список и окно чата

`AiChatList.vue` — плоский список `aiChatStore.chats` (сортировка по `updatedAt` desc), рендерится тем
же `RecycleScroller`/виртуальным списком, что и остальные вкладки (`ChatVirtualScroller`/существующий
паттерн `ContactList`/`ChannelList`), т.к. сообщение проекта — «дёшево, единообразно» — не изобретаем
новый список.

`AiChatView.vue` — **отдельный** компонент, не расширение `ChatWindow.vue`. Причина: `ChatWindow.vue`
завязан на Matrix-специфику (шифрование, read-receipts, реакции, медиа-пайплайн, звонки) — заводить туда
AI-ветвление означало бы «рефакторинг ради рефакторинга» тяжёлого компонента, прямо запрещённый текущим
проектным контекстом («Подход: только фикс/оптимизация — без рефакторинга ради рефакторинга»). AI-чат
проще: только текст, только пользователь/ассистент, стриминг вместо мгновенной доставки, никаких
реакций/пересылок/медиа в первой версии.

**Важно (parallel-work constraint из `CLAUDE.md`): другой разработчик сейчас работает над клавиатурой.**
`AiChatView.vue` должен **переиспользовать существующий компонент ввода/composer** (тот же, что в
`features/messaging`), а не писать новый текстовый инпут с нуля — избегаем дублирования
клавиатурной логики (`--keyboardheight`, safe-area, Android insets) и конфликта правок с параллельной
задачей. Если composer жёстко завязан на Matrix-отправку — выносим/параметризуем колбэк отправки, не
копируем компонент целиком.

Рендер стрима: токены копятся в реактивном состоянии стора (`streamingContent: Map<chatId, string>`),
не в Dexie на каждый токен (слишком частые записи IndexedDB). Периодический чекпоинт в Dexie
(например раз в ~1с) на случай убийства процесса посреди генерации — компромисс между «не терять длинный
ответ при краше» и «не забивать IndexedDB записями на каждый токен». Финальная запись — всегда при
`stream.result` (status `complete`/`cancelled`/`error`, по семантике ТЗ §9.8 — частичный ответ при
отмене тоже сохраняется, не отбрасывается).

`RuntimeBusyError` (ТЗ §9.4 — один LLM-контекст, одна генерация одновременно, даже между разными
AI-чатами): composer должен блокироваться (disabled + подсказка «дождитесь ответа в другом AI-чате»),
если `useLocalAiStore().isGenerating === true` для **любого** чата, не только текущего.

---

## 8. UI: Settings → Local AI

Прецедент — уже существующие пункты `SettingsPanel.vue` (`openSettingsContent('storage'|'networking'|...)`)
+ `SettingsSubView` union-тип (`use-sidebar-tab.ts:4`) + рендер контента в `SettingsContentPanel.vue`.
Добавляем `'localAi'` в `SettingsSubView`, новую кнопку в `SettingsPanel.vue` (гейт `v-if="isNative"` —
та же логика, что и `v-if="isElectron"` для Desktop-раздела чуть ниже в том же файле), новую секцию —
по паттерну уже вынесенных в `features/settings` (`StorageSettings`, `TorSettingsSection`,
`DesktopSettingsSection`) → `features/settings/ui/LocalAiSettingsSection.vue`.

Содержимое секции:

1. **Информация о модели**: `displayName`, `paramsB`×`quant` (например «Qwen 2.5 4B · Q4_K_M»),
   `sizeBytes` (человекочитаемо), статус — «Не скачана» / «Скачивается NN%» / «Готова» /
   «Доступно обновление».
2. **Eligibility-бейдж** — как `torStatusInfo` в `SettingsPanel.vue` (цвет + короткий текст):
   `ok` → не показываем вообще (всё штатно), `tight` → жёлтый «может работать медленно», `no` → красный
   «устройству не хватает памяти», `unknown` → серый «не удалось определить».
3. **Кнопка «Скачать модель» / «Обновить модель» / «Удалить модель»** — вызывает
   `useLocalAiStore().downloadModel()` / `switchModel()` / (delete — `releaseRuntime()` +
   удаление файла, метода в публичном API для «просто удалить не обновляя» нет напрямую, см. открытый
   вопрос §9 П.7).
4. **Прогресс-бар** — тот же `downloadState.model` (тот же Pinia-стор), что рендерится и в
   `AiModelGate.vue` внутри чата — **одно состояние, два места отображения**, никаких повторных
   `onProgress`-подписок.
5. **«Проверить обновления»** — `refreshManifest()`, по прямой аналогии с уже существующей кнопкой
   «Проверить обновления» APK (`SettingsPanel.vue:516-547`, Android sideload only) — тот же UX-паттерн
   (кнопка → спиннер → результат), другая цель.

---

## 9. Открытые вопросы (нужно решение продукта, не техническое)

По аналогии с `docs/decisions.md` самой библиотеки — фиксируем то, что план **сознательно** оставляет
открытым, а не додумывает молча:

| № | Вопрос | Текущее умолчание в плане |
|---|---|---|
| 1 | Хостинг `manifestUrl` (`local-ai-manifest.json`) — какой домен/CDN? | Не решено — нужен ответ до Фазы 0 roadmap |
| 2 | Конкретная модель (HF repo + pinned commit SHA) и embedding-артефакт для манифеста | Ориентир — Qwen 2.5/3 4B Instruct Q4_K_M (мультиязычная), embedding — bge-small-класс, оба placeholder |
| 3 | Первое сообщение в пустом AI-чате: явный клик «Скачать модель» или автостарт загрузки при отправке | В плане — явный клик (§4.1), альтернатива открыта |
| 4 | iOS в первой версии или Android-first | План — Android-first (текущий фокус проекта — Android-совместимость), iOS — fast-follow |
| 5 | `eligibilityPolicy` по умолчанию (`no → block` — сама библиотека уже так предлагает) | Принимаем умолчание библиотеки |
| 6 | Лицензия `@capgo/capacitor-downloader` (MPL-2.0, weak copyleft на уровне файлов плагина) совместима с лицензионной политикой Forta Chat? | Нужно подтверждение — не техническое решение |
| 7 | «Удалить модель, не скачивая новую» — нужен явный публичный метод в `local-ai` или обходимся `releaseRuntime` + прямым удалением файла снаружи API? | Открытый вопрос к библиотеке, возможно небольшое расширение API |
| 8 | Название npm-пакета при публикации `local-ai` (влияет на финальный `package.json` forta.chat) | Пока `file:` зависимость, имя не меняется до публикации |

---

## 10. Риски

| Риск | Митигация |
|---|---|
| Capacitor-адаптеры `local-ai` ни разу не запускались на реальном устройстве (только против реального `.d.ts`) | Обязательный ручной smoke-тест на слабом и мощном Android-устройстве в первой же фазе с нативным кодом — не полагаться на «N тестов зелёных» в `ROADMAP.md` библиотеки как на доказательство работы на телефоне (число растёт с каждым коммитом библиотеки, суть риска не меняется) |
| Рост размера APK (нативные бинарники `llama.cpp` под несколько ABI) | Замерить `cap sync` + release-сборку сразу после добавления `llama-cpp-capacitor`, до написания UI поверх |
| 4B-модель не потянется на части Android 7 устройств (цель проекта — не ломать остальное приложение) | Полагаемся на встроенные `checkSupport()`/`checkDeviceEligibility()` библиотеки, не обходим их; UI обязан честно показывать «AI недоступен на этом устройстве» |
| Загрузка модели (2–3 GB) через Tor (если у пользователя включён режим `always`) — практически не взлетит | Скачивание `local-ai` должно идти **мимо** Tor-прокси (аналогично тому, что уже отмечено в старом плане `docs/plans/llama/README.md`) — уточнить в `@capgo/capacitor-downloader` адаптере, использует ли он системный OS-загрузчик (обычно вне приложенческого прокси). **Непроверяемо чтением документации**: ADR `local-ai`'s ADR 0003 (`@capgo/capacitor-downloader`) вообще не рассматривает Tor/прокси-сценарий, только process-kill resume — вопрос закрывается только тестом на реальном устройстве в контексте прокси forta.chat (roadmap 7.3), не десk-ревью |
| `RuntimeBusyError` при попытке писать в два AI-чата одновременно | UI дизейблит composer глобально, пока идёт любая генерация (см. §7.3) |
| Конфликт с параллельной задачей по клавиатуре | `AiChatView.vue` переиспользует существующий composer-компонент, не пишет новый текстовый инпут (см. §7.3) |
| Мультиаккаунт: утечка контекста AI-чата между аккаунтами через общую SQLite `local-ai` | `databaseName` для `CapacitorSqliteAdapter` — per-account (§4.2), файл модели — общий |
| Манифест недоступен / невалиден (нет сети при первом запуске Settings → Local AI) | Библиотека уже это обрабатывает (`manifest:invalid`, кэш последнего валидного) — просто прокинуть событие в `initError` стора, показать человеко-читаемое сообщение |

---

## 11. Логирование и диагностика

Добавлено в `local-ai` 2026-08-11 (после первой версии этого плана, `docs/decisions.md` → «Local
logging & export», `docs/guides/logging-and-export.md`) — два независимых механизма:

1. **`config.logger`** — пробрасываемый колбэк (`debug`/`info`/`warn`/`error`), no-op по умолчанию
   (ТЗ §14). Вызывается на **каждое** внутреннее событие/ошибку библиотеки (`manifest:invalid`,
   `download:failed`, `device:eligibility-warning`, `runtime:*`, `vector-store:fallback-active` и т.д.)
   — не персистентный, чисто in-process хук.
2. **`config.logging`** (`{ enabled, minLevel, maxEntries }`, по умолчанию `enabled: false`) —
   отдельный, **опциональный** персистентный лог-стор в собственной SQLite `local-ai` (не в Dexie!),
   с потолком `maxEntries` (по умолчанию 5000, старые записи вытесняются). Читается обратно через
   `client.exportLogs({ since?, level?, limit? })` → `LogEntry[]`, чистится `client.clearLogs()`.
   Библиотека сознательно не пишет файл и не вызывает share-sheet сама — эта пара методов отдаёт
   только данные, экспорт в файл/шаринг — на стороне приложения (тот же паттерн, что и
   `exportChat()`/`exportChats()`).

**Почему это релевантно именно для forta.chat.** Главный сквозной риск этого плана (§1, §10) —
Capacitor-адаптеры `local-ai` ни разу не проверялись на реальном устройстве, а проект и так работает
«вслепую» по жалобам пользователей, без лабораторных устройств (`CLAUDE.md`: «Данные: Ориентируемся на
жалобы пользователей, нет лабораторных устройств для тестирования»). У Forta Chat уже есть готовый
канал для ровно такого сценария — `features/bug-report` (`BugReportModal`, `getLocalIssueCache`,
`BugReportStatusSheet`). План:

- Включить `config.logging.enabled: true` (уровень `'warn'` или `'info'` — решить в Фазе 2, не
  `'debug'`, чтобы не забивать 5000-лимит шумом) при создании `LocalAiClient` в
  `entities/local-ai/lib/create-client.ts`.
- `config.logger` завести на существующие консольные соглашения проекта
  (`console.warn`/`console.error` с префиксом модуля, `CLAUDE.md` → Error Handling) —
  `logger.warn/error → console.warn/error("[LocalAi] ...")`, `logger.debug/info` — no-op (проект и так
  не использует `console.log` в проде).
- Когда пользователь открывает бажрепорт из AI-чата или Settings → Local AI (или бажрепорт открыт в
  принципе, пока AI-фича активна в сессии) — прикладывать `await client.exportLogs({ limit: 200 })` к
  телу репорта тем же способом, каким уже собираются остальные диагностические данные
  (`getLocalIssueCache`) — не изобретать отдельную кнопку «Export AI logs», встроить в существующий
  флоу.
- Это **не блокер** и не меняет архитектуру плана — чистое дополнение поверх Фазы 2/7 (см. roadmap
  2.2, 7.6). Отмечено отдельным пунктом, т.к. в первой версии плана библиотека этого ещё не умела.

---

## 12. Связанные материалы

- Библиотека: `C:\inetpub2026\localai\README.md`, `docs/2026-08-10-local-ai-library-tz.md` (полное ТЗ),
  `ROADMAP.md` (статус фаз 0–8 + security), `docs/decisions.md` (открытые продуктовые вопросы самой
  библиотеки), `docs/guides/mode-b-integration.md`, `docs/guides/manifest-format.md`,
  `docs/guides/logging-and-export.md` (§11).
- Предыдущий (более ранний, LoRA-адаптерный) план в этом репозитории —
  [`docs/plans/llama/README.md`](../llama/README.md) — архитектурно устарел (библиотека тогда
  подразумевала `llama-cpp-capacitor` напрямую + LoRA-адаптеры-как-чаты; сейчас есть готовая
  `local-ai` со своим Mode B, LoRA не используется вовсе) — держим только как исторический контекст,
  не как источник решений для этого плана.
- Dexie / local-first: `src/shared/lib/local-db/schema.ts`, `channel-repository.ts` (образец простого
  репозитория без sync-engine).
- Прецедент отдельной некомнатной вкладки: `src/entities/channel/`, `src/features/channels/`,
  `src/widgets/sidebar/ChatSidebar.vue`.
- Settings-паттерн: `src/widgets/sidebar/ui/SettingsPanel.vue`,
  `src/widgets/sidebar/ui/SettingsContentPanel.vue`, `src/widgets/sidebar/model/use-sidebar-tab.ts`.
- Platform-флаги: `src/shared/lib/platform/index.ts` (`isNative`, `resolveAppUpdaterEnabled` — образец
  для будущего `resolveLocalAiEnabled`, если понадобится).
- Android-сборка: `docs/android-local-build.md`, `android/app/build.gradle`.
