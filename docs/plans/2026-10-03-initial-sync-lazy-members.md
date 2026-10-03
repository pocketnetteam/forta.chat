# Первый /sync на больших аккаунтах: lazy loading участников — план — 2026-10-03

> **Для новой сессии.** Вставить в первое сообщение:
>
> > Работаем по `docs/plans/2026-10-03-initial-sync-lazy-members.md`. Начни с этапа «…». Перед правкой сверь
> > предпосылки этапа с кодом — номера строк в плане могут устареть, ориентируйся на имена функций.
>
> Правила сборки, тестов и ревью — в `AGENTS.md`. Этот план их не повторяет.

Связанные планы: [2026-10-02-decrypt-priority-roadmap.md](2026-10-02-decrypt-priority-roadmap.md) (расшифровка
превью и загрузка ключей — тот же путь `ensureRoomCrypto` → `pcrypto.addRoom` → `prepare()`).

Связанный коммит: `eccf0a52` «perf: limit background history backfill to warm rooms, batch peer keys» —
разбор волны одиночных `getuserprofile`. Ввёл `preloadBackfillKeys` в `chat-store.ts` и хук `beforePass` в
`history-backfill.ts`. Этот план на него опирается (раздел 5.6, этап 2a).

---

## 1. Симптом

Аккаунт с ~5000 чатов. Первый запуск (нет sync-токена): первый `/sync` проходит только с ~5-й попытки.

Запрос: `GET /_matrix/client/v3/sync?filter=<inline>&timeout=0&set_presence=offline&_cacheBuster=…`.
Фильтр — из `matrix-client.ts` (блок «Create a server-side sync filter»): `timeline.limit: 4`,
`state.lazy_load_members: false`, `state.types` включает `m.room.member`.

## 2. Почему проходит с N-й попытки

- **Клиент** ждёт первый sync `timeout(0) + BUFFER_PERIOD_MS(80 s)` (`matrix-js-sdk-bastyon/src/sync.ts`,
  `doSyncRequest`), потом обрывает запрос.
- **Прокси перед Synapse** (если nginx) по умолчанию режет на 60 s (`proxy_read_timeout`) → 504. Не проверено.
- **Synapse** продолжает считать ответ после обрыва и кэширует его. Ключ кэша — пользователь, устройство,
  `since`, фильтр, `timeout`; `_cacheBuster` в ключ не входит. Каждый повтор подключается к тому же вычислению,
  и когда оно заканчивается, ответ приходит сразу.

Как отличить: DevTools → Network. 502/504 через ~60 s — режет прокси. «(canceled)» ровно через ~80 s — SDK.

## 3. Варианты (от простого к сложному)

| # | Что | Риск | Статус |
|---|---|---|---|
| A | Сервер: `proxy_read_timeout`/`proxy_send_timeout` 300 s для `/_matrix/client/*/sync`, gzip для JSON, sync-worker Synapse, кэши | Нет (клиент не меняется) | Вне репозитория |
| B | Клиент: в `doSyncRequest` при `syncToken === null` `localTimeoutMs` ~5 мин (правка форка SDK, 2–3 строки) | Низкий | Не начато |
| C | Lazy loading участников (этот план, разделы 4–7) | Высокий: крипта | Не начато |
| D | Sliding sync (MSC4186, Synapse ≥ 1.114) | Большая работа; проверить поддержку в форке SDK | Идея |

Ещё: если большая часть 5000 комнат — мёртвые группы, `leave` + `forget` на стороне аккаунта сразу облегчит sync.

**Перед переключением флага — замер (этап 0, фаза II).** Весь выигрыш C зависит от того, какую долю ответа занимают `m.room.member`
больших групп. Если основная масса — 5000 диалогов по 2 человека, C даст мало при всех рисках ниже.

---

## 4. История и предпосылки

- Lazy loading уже был включён и выключен в коммите `ba89a056`: в новом 1:1 чате member-событие собеседника не
  приходило, пока он не напишет, `getusershistory()` (`matrix-crypto.ts`) видел только себя, `canBeEncrypt()`
  возвращал false → ложный баннер «peer hasn't published encryption keys».
- Оригинальный bastyon-chat тоже работал без lazy loading (`mtrx.js`: `//lazyLoadMembers : true`).
- Код частично остался от времён lazy loading: `loadMissingMembers` (первые ~15 комнат), `loadMembersForRooms`
  (видимые строки в `ContactList.vue`/`ContactsPanel.vue`), `loadMembersIfNeeded` при открытии чата
  (без await), защита «members не может стать короче» в `fullRoomRefresh` и инкрементальном refresh.

### Что проверено в SDK (`node_modules/matrix-js-sdk-bastyon` 23.2.5)

- `Room.loadMembersIfNeeded()` → `/members?not_membership=leave&at=<sync token>`: **вышедшие и кикнутые не
  приходят**. Результат кэшируется в IndexedDB (`setOutOfBandMembers`), повторно с сервера берётся только для
  комнат с `m.room.encryption` и `state_key ""` (`hasEncryptionStateEvent`). У комнат Bastyon вместо этого
  `m.set.encrypted`, поэтому для них кэш используется всегда.
- Загруженные участники пишутся через `setStateEvent` → видны в `currentState.getStateEvents("m.room.member")`,
  которые читает Pcrypto. В `oldState` не попадают.
- Каждый загруженный участник эмитит `RoomMember.membership` → `onMembership` в `stores.ts` → `markRoomChanged`,
  debounced recheck ключей, `refreshRooms()` (debounce 150 ms). Нагрузка приемлемая.
- **Проверки смены флага lazy loading нет** (нет `InvalidStoreError`). Поднимать `matrix-js-sdk-v7` → `v8` не
  нужно: существующие пользователи сохранят полный state и не повторят тяжёлый первый sync.
- `IndexedDBStoreWorker` (sync-store worker из ветки `crypto-fix-0110`) поддерживает
  `get/set/clearOutOfBandMembers`.
- С `lazyLoadMembers` SDK сам добавляет lazy-фильтр в `/messages` и `/context` (`client.ts`). Вызов
  `createMessagesRequest` с собственным фильтром в `matrix-client.ts` это не затрагивает.

### Что проверено в Synapse-поведении (по спецификации и коду Synapse, не на сервере)

- При lazy loading в `state` приходят member-события только авторов событий из `timeline`, и это касается и
  инкрементальных sync с `limited: true`.
- У 1:1 чатов Bastyon есть `m.room.name = "#<sha224>"` → Synapse не считает heroes. Собеседник приходит, только
  если он автор одного из последних 4 событий.
- События игнорируемых пользователей вырезаются из sync → их member-событие при lazy loading не придёт никогда.
- Summary (`m.joined_member_count`) Synapse присылает только при lazy loading; сейчас `getJoinedMemberCount()`
  считает по полному state, после включения — по summary. Обе ветки в коде уже есть.
- Своё member-событие Synapse при lazy loading включает. Подтвердить на замере (этап 0).

---

## 5. Риски (почему нельзя просто включить флаг)

### 5.1 Групповой ключ на неполном списке — тихая потеря сообщений

`encryptEventGroup` → `usershash()` хэширует текущих участников (`preparedUsers(0)`) и по хэшу ищет/создаёт
общий ключ (`pcrypto.<uid>.<hash>`). При неполном списке клиент создаст новый ключ для части группы, остальные
не смогут прочитать сообщения, ошибки не будет. **Перед любым шифрованием участники должны быть загружены.**

### 5.2 Устаревший кэш участников после разрыва sync — безопасность

После limited sync Synapse не присылает изменения членства тех, кто не писал. Кэш из IndexedDB остаётся
старым: кикнутому продолжают шифровать новые ключи, вступивший во время разрыва их не получает. При
`timeline.limit: 4` limited sync — обычное дело после любого офлайна.

### 5.3 Диалоги с заблокированными перестанут скрываться

`shouldExcludeLocalRoomFromSidebar` и `totalUnread` (`chat-store.ts`) берут собеседника из `members`. Для
игнорируемых он не придёт (см. раздел 4) → при первой установке такие диалоги появятся в списке и в счётчике.

### 5.4 Ошибка, которую легко сделать: загрузка в `prepare()`

`prepare()` вызывается и при расшифровке превью: `decryptRoomPreviews` → `ensureRoomCrypto` → `addRoom` →
`prepare`. Загрузка участников там = волна `/members` на каждом старте. Для расшифровки полный список не нужен:
отправитель всегда известен, а в 1:1 есть запасной путь через ключи из тела (`stillMissing` в
`decryptEvent`/`decryptKey`).

### 5.6 Lazy loading вернёт волну одиночных `getuserprofile`

Как устроено после `eccf0a52`:
- Очередь `getuserprofile` в `public/js/lib/client/sdk.js` (`userInfo.load`, `light=true`) склеивает только
  вызовы, попавшие в одно окно 300 мс. Профили без ключей SDK в IndexedDB не сохраняет → после перезапуска
  снова промах.
- `resolveCryptoUsersInfo` (`entities/auth/lib/crypto-users-info.ts`) не запрашивает тех, чьи ключи уже в
  памяти SDK, а запрос на адрес, который уже в полёте, присоединяется к нему.
- Поэтому пачка, запущенная **до** поштучных `getusersinfo`, превращает тысячи одиночных запросов в один на
  ≤ 70 адресов. Так сейчас сделано только в фоновом доборе истории: `preloadBackfillKeys` вызывается из
  `scheduleContinuityChecks` и из `beforePass` очереди.

Что сломает lazy loading:
- `preloadBackfillKeys` берёт адреса из `matrixRoomAddresses` (участники SDK, заполняет `updateDisplayNames`)
  и **только если там пусто** — из `ChatRoom.members`. У 1:1 без загруженного собеседника в
  `matrixRoomAddresses` будете только вы → список не пуст → фолбэк на `members` из Dexie не сработает → пачка
  пустая.
- Дальше каждая комната в `decryptEvent`/`decryptKey` упрётся в `hasMissing`, допишет собеседника из тела
  события и вызовет `getusersinfo()` сама → одиночный запрос на комнату. Та же волна, что разбирали в
  `eccf0a52`, только на шаг позже.
- Порог «группа ≥ 50 — ключи не грузить» (`BACKFILL_KEYS_MAX_MEMBERS`) считается по числу адресов. При
  неполном списке большая группа его пройдёт. Вреда мало (лишние адреса), но проверять надо по
  `getJoinedMemberCount()`, как это делает Pcrypto.
- Этап 4 (фоновая догрузка 1:1) на каждого пришедшего участника эмитит `RoomMember.membership` →
  `onMembership` в `stores.ts` → у каждой комнаты свой таймер 500 мс → `roomCrypto.prepare()` →
  `getusersinfo`. Таймеры срабатывают вразнобой → снова одиночные запросы. Касается только комнат, у которых
  уже есть экземпляр крипты (`pcrypto.rooms[roomId]`), но после расшифровки превью таких много.

Откуда брать собеседника без загрузки участников:
- `content` зашифрованного события: тело Pcrypto (`body` / `secrets` → Base64 → JSON) — объект, ключи которого
  hex-id получателей. Собеседник там есть и в ваших собственных сообщениях. Расшифровка сама так делает
  (`stillMissing` → `users[uid] = …`).
- Авторы событий из live timeline — их member-события приходят всегда.

### 5.6.1 Карта: откуда грузится `getuserprofile` (проверено поиском 2026-10-03)

Единственный сетевой выход — `psdk.userInfo.load` в `public/js/lib/client/sdk.js`. При `light=true` вызов
идёт через очередь (окно 300 мс, ≤ 70 адресов), при `light=false` — сразу, ≤ 10 адресов. Нативный код
(Android/iOS) `getuserprofile` не вызывает, `satolist.js` тоже. Один и тот же ответ несёт и имя, и ключи
шифрования, поэтому загрузка профиля для имени заодно кладёт ключи в память SDK.

Обёртки в `app-initializer.ts`:
- `loadUsersInfo` (`light=true`) — почти все пути ниже;
- `loadUserData` / `initializeAndFetchUserData` (`light=false`) — только свой профиль;
- `loadUsersInfoRaw` (`update:true`) — только свой профиль (регистрация, проверка ключей);
- `loadUsersBatch` (`light=false`) — вызовов нет, мёртвый код.

**Путь ключей (крипта)**: `getusersinfo` (`matrix-crypto.ts`) → `getUsersInfo` (`stores.ts`) →
`resolveCryptoUsersInfo` → `loadUsersInfo`. `getusersinfo` вызывается из `prepare()` (адреса = участники
комнаты) и из запасного пути в `decryptEvent` / `decryptKey` (адреса = тело события + отправитель).

| Кто вызывает `prepare` / расшифровку | Сколько комнат | Пачка сейчас | При lazy loading |
|---|---|---|---|
| Фоновый добор: `ingestRawHistory` ← `startBackfillPass` | Очередь по одной | `preloadBackfillKeys` | **Дыра**: адреса из участников (5.6) |
| Превью: `decryptRoomPreviews` → `decryptOnePreview` | ≤ 20 за цикл, пул по 5 (без worker — по 1) | Нет | **Дыра**: без worker одиночные; собеседник только из тела |
| `DecryptionWorker` (`shared/lib/local-db/decryption-worker.ts`): задания из Dexie `decryptionQueue` | До 20 заданий из разных комнат, **строго по очереди** | Нет | **Дыра**: у каждой комнаты свой запрос из запасного пути. Есть и сейчас, при lazy loading станет массовой |
| `onMembership` → таймер 500 мс → `prepare()` (`stores.ts`) | По таймеру на каждую комнату | Нет | **Дыра** (этап 4 вызовет волну) |
| Видимые строки без превью: `fetchRoomPreview` → `loadRoomMessages` | Параллельно до `VIEWPORT_FETCH_MAX_CONCURRENT` | Склеивается окном SDK | Терпимо; редкий путь (только строки без превью в Dexie) |
| Живые события: `handleTimelineEvent` ← `onTimeline` (`stores.ts`) | Параллельно, после офлайна — сотни | Склеивается окном SDK | Терпимо; проверить на замере после офлайна |
| Открытие/история чата: `loadRoomMessages`, `loadMoreMessagesViaSdk`, `prefetchNextBatch`, `loadAllMessages`, `refreshOpenedRoom`, `exitDetachedMode`, `parseSingleEvent`, `enrichUnresolvedReplies`, `applyPageRelationsToStored`, `scheduleSdkRoomRecovery` | Одна (открытая) | Один запрос на комнату | Нужен `ensureRoomMembers` только для шифрования |
| `checkPeerKeys`, `scheduleActiveRoomKeysRetry`, `use-file-download` (`waitForRoomCrypto` → `decryptKey`) | Одна | Один запрос | То же |
| Свой профиль: `cryptoInstance.prepare(address)`, `fetchUserInfo`, регистрация | — | — | Не затронуто |

**Путь имён (профили)** — через `user-store.ts` (`loadUserIfMissing`, `loadUsersBatch` → `ProfileLoader`,
`_scheduleBackgroundRevalidation`, `refreshStaleUsers`):

| Кто | Откуда адреса | При lazy loading |
|---|---|---|
| `loadProfilesForRoomIds` (`chat-store.ts`) ← старт (первые 15), `ContactList.vue`, `ContactsPanel.vue`, открытие чата, инкрементальный refresh, `loadMissingMembers`, `loadMembersForRooms` | `matrixRoomAddresses`, **и только если там пусто** — `ChatRoom.members` | **Дыра**: у 1:1 без собеседника там только вы → вы в кэше → комната помечается в `profilesRequestedForRooms` как готовая, собеседник не запрошен. Снимает только `loadMembersForRooms` для строк с нераспознанным именем |
| `ContactList.vue` `sysAddrs` (адреса из системных сообщений) | События | Не затронуто |
| `use-mention-autocomplete.ts` | Участники открытой комнаты | Неполный список, пока не догрузятся участники при открытии (без await) |
| `UserAvatar.vue`, `ChatWindow.vue`, `call-service.ts`, `ChatInfoPanel.vue`, `UserProfilePanel.vue` | Конкретный адрес | Не затронуто |
| `refreshStaleUsers` (через 30 с, по 10 с паузой 1 с), фоновая ревалидация | Кэш `localStorage` | Не затронуто |
| WebSocket `onUserInfo` (`update:true`) | Событие блокчейна | Не затронуто |
| Посты, комментарии, превью ссылок, коллекции, переключатель аккаунтов, настройки | Не участники чатов | Вне плана |

### 5.7 Крипта при загруженных участниках — эквивалентна

Проверено: Pcrypto берёт только текущее member-событие каждого пользователя; вышедшие (`leave`) в группе дают
пустую `life`, в 1:1 отфильтрованы. Поэтому `/members` без вышедших даёт тот же набор `users`, что и полный
state. Групповая расшифровка берёт хэш из события (`content.hash`).

---

## 6. Все места, где нужны участники

### 6.1 Требуют загрузки (await)

| Место | Что сломается | Действие |
|---|---|---|
| `matrix-crypto.ts`: `encryptEvent`, `encryptEventGroup` | Исходный баг; риск 5.1 | `ensureRoomMembers` → пересчёт `getusershistory()` + `getusersinfo()` перед шифрованием |
| `chat-store.ts` `checkPeerKeys` (ветка активной комнаты) | Ложный баннер «missing» | await `ensureRoomMembers` до `canBeEncrypt()` |
| `call-service.ts` исходящий звонок (`getJoinedMembers` для peer) | Пустой `peerId` | await перед поиском собеседника |
| `chat-store.ts` удаление чата (kick всех перед leave, `getJoinedMembers`) | Собеседник не кикнут | await |
| `chat-store.ts` список забаненных (`getMembersWithMembership("ban")`) | Неполный список | await |

### 6.2 Деградация на первой установке (без собеседника в 1:1)

| Место | Что видно | Действие |
|---|---|---|
| Фильтр игнорируемых (`shouldExcludeLocalRoomFromSidebar`, `totalUnread`) | Заблокированные в списке | Фоновая догрузка (этап 4) |
| Имена/аватары 1:1 в списке | `#hash` у непрокрученных строк | Уже есть догрузка видимых строк; плюс этап 4 |
| Поиск по имени (`use-search.ts`, `rank-chat-rooms.ts`) | Не находит незагруженные диалоги | Этап 4 |
| Индикатор «печатает» | SDK шлёт typing только известным участникам (`RoomState.setTypingEvent`) | Этап 4 |
| `push-service.ts` (имя отправителя через `room.getMember`) | Сырой Matrix ID | Фолбэк на профиль по адресу |
| `stores.ts` `setAllSenderNamesGetter` (`getJoinedMembers` по всем комнатам) | Меньше имён в `sender_name_*` на Android | Брать из профилей/Dexie |
| `stores.ts` `setAllRoomNamesGetter` → `room_name_*` на Android | `#hash` в заголовке нативного пуша | Не отправлять нераспознанные имена |

### 6.3 Проверено — менять не нужно

- Определение 1:1 (`MatrixKit.isTetatetChat`): без собеседника срабатывает фолбэк по имени `#` + 56 hex.
- Поиск существующего 1:1 при создании (`use-contacts.ts`) — по alias.
- Права (`getMemberPowerLevel`, `canSendStateEvent`) — фолбэк на `m.room.power_levels`.
- Свой бан (`room-guards.ts`) — своё member-событие приходит всегда.
- Входящий звонок — отправитель invite известен; `MatrixCall` берёт `getMember(sender)`.
- Dexie: защита «members не может стать короче» в `fullRoomRefresh` и инкрементальном refresh;
  `bulkSyncRooms` пишет `members` как есть, но на вход уже идёт защищённый список.
- Android/iOS нативный код участников не читает, только `room_name_*` / `sender_name_*`.
- `background-sync.ts` — отдельный поллер непрочитанных, уже с lazy-фильтром.
- Мелочь, не связанная с lazy loading: защита по длине оставляет кикнутого в `members`, если список был длиннее.
  С lazy loading срабатывать будет чаще — учесть в тестах этапа 3.

---

## 7. Этапы

Порядок: **фаза I** — весь код при `lazyLoadMembers: false` → **контрольная точка**: проверка владельцем на
реальном аккаунте → **фаза II** — замер и переключение флага в `true` отдельным коммитом.

### Почему код можно писать заранее при `false` (проверено в SDK 23.2.5)

- Конструктор `Room` при выключенном флаге ставит `membersPromise = Promise.resolve(false)`
  (`models/room.ts`, «awaited by getEncryptionTargetMembers») → `loadMembersIfNeeded()` возвращает его сразу,
  `/members` не вызывается. Флаг доходит до каждой комнаты: все комнаты создаются в `sync.ts`
  (`new Room(…, { lazyLoadMembers: opts.lazyLoadMembers })`).
- `clearLoadedMembersIfNeeded()` начинается с `if (this.opts.lazyLoadMembers && this.membersPromise)` → no-op.
- `room.membersLoaded()` при выключенном флаге всегда `true`.
- Напрямую `/members` приложение не вызывает (поиск по `src/` — только комментарии).

Итого в фазе I загрузка участников (этапы 2, 3, 4) — пустые ветки без сетевых запросов, а пачечная загрузка
ключей (этап 2a) работает сразу и даёт выигрыш уже без lazy loading.

**Требование к тестам фазы I:** тесты на загрузку участников мокают комнату с `membersLoaded() === false` и
настоящим (мок) `loadMembersIfNeeded`, иначе при `false` они проверят только пустую ветку. Отдельный тест: при
`membersLoaded() === true` helper не вызывает `loadMembersIfNeeded`.

---

## Фаза I — код при `lazyLoadMembers: false`

Флаг и фильтр (`lazy_load_members: false`, `lazyLoadMembers: false`) в `matrix-client.ts` не трогать.
Тест `matrix-client-lazy-load-members.test.ts` (требует `false`) остаётся как есть.

### Этап 1. Таймауты (A + B)

- A — запрос админам сервера.
- B — форк SDK: в `doSyncRequest` при `syncToken === null` увеличить `localTimeoutMs`. Тест на параметры
  запроса первого и инкрементального sync.

### Этап 2. `ensureRoomMembers` + точки 6.1

- Helper в `entities/matrix` (или `entities/chat/lib`): `ensureRoomMembers(roomId)` — **первой** проверкой
  `room.membersLoaded()` (при `false` всегда `true` → выход), затем пропуск при `getJoinedMemberCount() >= 50`;
  дедупликация параллельных вызовов (SDK и так возвращает `membersPromise`, но нужен таймаут через
  `withTimeout`, чтобы отправка не повисла).
- `PcryptoRoomInstance`: метод, который ждёт участников и пересчитывает `users`/`usersinfo`; вызывать из
  `encryptEvent`/`encryptEventGroup`. **Не** из `prepare()` (риск 5.4).
- Остальные точки из 6.1.

### Этап 2a. Общая пачечная загрузка ключей (риск 5.6)

Обязателен до переключения флага: без него `true` вернёт волну одиночных `getuserprofile`. Работает и при
`false` — превью, `DecryptionWorker`, `onMembership`, `loadProfilesForRoomIds` сокращают число запросов уже
сейчас.

**Helper.** Обобщить `preloadBackfillKeys` в `preloadRoomKeys(roomIds)` (`chat-store.ts`; имя — по месту):
- адреса комнаты = объединение `matrixRoomAddresses`, `ChatRoom.members` (Dexie, защищён от усыхания),
  авторов событий live timeline и hex-id из тела зашифрованных событий live timeline (их ≤ 4 на комнату после
  sync, парсинг Base64 + JSON дешёвый). Невалидное тело — пропустить молча;
- пропуск комнаты, если `max(getJoinedMemberCount(), число адресов) >= 50`;
- свой адрес исключить; один вызов `authStore.loadUsersInfo([...])` на все комнаты; fire-and-forget, как сейчас.

**Правило.** Везде, где для **нескольких комнат подряд** вызывается `ensureRoomCrypto`/`prepare`/расшифровка,
сначала вызвать `preloadRoomKeys` для всех этих комнат. Для одной комнаты не нужно: `prepare()` → `getusersinfo`
и так отправляет всех её участников одним запросом.

| Место | Сейчас | Что сделать |
|---|---|---|
| Фоновый добор истории: `scheduleContinuityChecks`, `beforePass` | `preloadBackfillKeys` | Перевести на `preloadRoomKeys` |
| Расшифровка превью `decryptRoomPreviews` | Нет пачки. Пул по 5 комнат (`PREVIEW_DECRYPT_BATCH_SIZE`), без crypto worker — по 1; ≤ 20 за цикл | `preloadRoomKeys(capped)` перед пулом |
| `DecryptionWorker`, фаза расшифровки тика | Нет пачки. До 20 заданий из разных комнат по очереди | Перед циклом собрать адреса из `encryptedBody` заданий (тело Pcrypto + `sender`) и вызвать один `loadUsersInfo`. Воркер живёт в `shared/` — передать загрузчик зависимостью в `initChatDb`, как `getRoomCrypto` |
| Recheck ключей в `onMembership` (`stores.ts`) | Таймер 500 мс на каждую комнату | Общий debounce: собрать комнаты за окно → `preloadRoomKeys(все)` → `prepare` + `checkPeerKeys` по каждой |
| `loadProfilesForRoomIds` (путь имён) | Адреса из `matrixRoomAddresses`, `ChatRoom.members` — только если первый пуст | Тот же источник адресов, что у `preloadRoomKeys` (объединение). Не помечать 1:1 в `profilesRequestedForRooms`, пока собеседник неизвестен |
| Этап 4 (фоновая догрузка 1:1) | — | Закрывается пунктом выше; отдельный вызов не нужен |
| Шифрование, `checkPeerKeys` открытого чата, звонок, удаление чата | Одна комната | Не нужно (`ensureRoomMembers` → `prepare` — один запрос) |
| `handleTimelineEvent` (живые события по многим комнатам после офлайна) | Параллельные вызовы, склеиваются окном SDK | Не трогать; проверить на замере после офлайна |
| `enrichUnresolvedReplies`, `applyPageRelationsToStored`, `scheduleSdkRoomRecovery`, `use-file-download` | Одна (открытая) комната | Не нужно |

### Этап 3. Сброс кэша при разрыве (риск 5.2)

В обработчике `Room.timelineReset` (`matrix-client.ts`, main timeline) вызывать
`room.clearLoadedMembersIfNeeded()`. Следующая отправка перезагрузит участников с сервера.

### Этап 4. Фоновая догрузка 1:1 (6.2)

После `PREPARED`, с низким приоритетом: для комнат, где `getJoinedMemberCount() <= 2` и собеседник неизвестен
(`others.length === 0`, как в `loadMissingMembers`), — `loadMembersIfNeeded` по 3–4 параллельно, с паузами.
Существующих пользователей с полным state не трогает. Кэш в IndexedDB → один раз за установку.
Группы грузятся только при открытии. Ключи для этих комнат здесь **не** грузить: догрузка нужна для имён,
поиска, игнор-листа и typing. Recheck ключей, который она вызовет через `onMembership`, идёт пачкой (этап 2a).

### Этап 5. Имена для пушей (6.2)

`push-service.ts` и геттеры имён в `stores.ts`: фолбэк на профили, не отправлять в native имена вида `#hash`.

### Готовность фазы I

- `npm run build`, `npm run test`, `/code-review` — по `AGENTS.md`.
- Записи в `docs/manual-verification.md` для пунктов фазы I (раздел 9).
- Можно коммитить этапами (1, 2 + 3 + 4 + 5, 2a). При `false` поведение меняют только 1 (таймаут первого
  sync), 2a (пачки ключей) и 5 (имена для пушей); 2, 3, 4 — пустые ветки.

---

## Контрольная точка — проверка владельцем (при `false`)

Перед фазой II владелец проверяет на реальном аккаунте (Web и Android), что при `false` ничего не сломалось и
пачки работают — список «Фаза I» в разделе 9. Фаза II начинается только после его подтверждения.

---

## Фаза II — переключение в `true`

### Этап 0. Замер (до переключения)

Сохранить ответ первого `/sync` из DevTools (Response → Save) и посчитать: размер по типам событий, долю
`m.room.member`, распределение комнат по числу участников, вклад групп ≥ 50. Свой member-событие — есть ли.
Решение: если члены больших групп < ~50% ответа, флаг не переключать — код фазы I остаётся безвредным
(пустые ветки), выигрыш дают A + B и 2a. Для сравнения потом — тот же замер с `true`.

### Этап 6. Переключение флага

Отдельный коммит, чтобы откатывался одной правкой:
- `lazy_load_members: true` в `state` фильтра, `lazyLoadMembers: true` в `startClient` (`matrix-client.ts`;
  `timeline.lazy_load_members` тоже `true` или убрать — на state он не влияет). Обновить комментарии там же
  (сейчас объясняют, почему `false`).
- Заменить `matrix-client-lazy-load-members.test.ts` на проверку `true`.
- Версию хранилища (`matrix-js-sdk-v7`) **не** поднимать: проверки смены флага в SDK нет, существующие
  пользователи сохранят полный state.
- Ручная проверка — список «Фаза II» в разделе 9.

Откат: вернуть два значения в `false`. Кэш участников в IndexedDB (`oob_membership_events`) при `false` не
читается — безвреден.

---

## 8. Тесты

- `encryptEventGroup` с неполным списком ждёт загрузки и хэширует полный набор (регрессия 5.1).
- `checkPeerKeys` для нового 1:1 без member-события собеседника → после загрузки «available», не «missing»
  (регрессия бага из `ba89a056`).
- Расшифровка превью **не** вызывает `loadMembersIfNeeded` (регрессия 5.4).
- `preloadRoomKeys`: 1:1 без загруженного собеседника → адрес берётся из тела зашифрованного события и из
  `ChatRoom.members`; группа с `getJoinedMemberCount() >= 50` пропускается при неполном списке; на N комнат —
  один вызов `loadUsersInfo` (регрессия 5.6).
- `decryptRoomPreviews` вызывает пачку до пула расшифровки.
- `DecryptionWorker`: тик из заданий N комнат → один `loadUsersInfo` с адресами из тел событий до первой
  расшифровки.
- `loadProfilesForRoomIds`: 1:1, где `matrixRoomAddresses` = [свой адрес], а в `ChatRoom.members` есть
  собеседник → собеседник запрошен, комната не помечена готовой раньше времени.
- `onMembership` по нескольким комнатам в одном окне → один `loadUsersInfo`, затем `prepare` по каждой.
- `timelineReset` → `clearLoadedMembersIfNeeded` (5.2).
- Фоновая догрузка: только 1:1 без собеседника, ограничение параллельности, пропуск при полном state.
- Исходящий звонок, удаление чата, список банов — ждут участников.
- Фильтр игнорируемых после фоновой догрузки скрывает диалог.

## 9. Ручная проверка (в `docs/manual-verification.md` в том же коммите)

### Фаза I (`false`) — контрольная точка владельца

Цель: при `false` поведение не изменилось, пачки ключей работают.
- В Network нет ни одного запроса `/members` за всю сессию: старт, скролл списка, открытие чатов, отправка,
  звонок, удаление чата, офлайн → онлайн.
- `[enqueue]`-логпоинт в `sdk.js` (как в `eccf0a52`): после первого sync, при скролле списка, после офлайна —
  несколько `userInfoLight` с десятками адресов, не поток записей с одним адресом.
- Превью в списке расшифровываются, имена и аватары на месте; заблокированные скрыты.
- Отправка в 1:1 и в группу, собеседник читает; звонок; удаление чата.
- Первый вход на большой аккаунт: время первого sync и число попыток (эффект этапа 1).
- Пуш из незапущенного приложения: в заголовке имя, не `#hash` и не Matrix ID (этап 5).

### Фаза II (`true`)

- Первый вход на аккаунт с тысячами чатов: время первого sync, число попыток — сравнить с фазой I.
- Новый 1:1 → сразу отправить сообщение: нет ложного баннера, собеседник читает.
- Группа: кикнуть участника с другого устройства, пока этот клиент офлайн; вернуться → новое сообщение
  кикнутый не читает. Обратный случай с добавлением.
- Звонок из чата, который в этой сессии не открывали.
- Заблокированный пользователь не появляется в списке после чистой установки.
- Пуш из незапущенного приложения: в заголовке имя, не `#hash` и не Matrix ID.
- `[enqueue]`-логпоинт: после первого sync и во время этапа 4 — пачки по десяткам адресов, не поток одиночных.
- `/members` — только при открытии групп, отправке, звонке и в фоновой догрузке 1:1 (этап 4), не волной.

## 10. Открытые вопросы

- Режет ли прокси на 60 s (этап 0 / Network).
- Поддерживает ли форк SDK simplified sliding sync (вариант D).
