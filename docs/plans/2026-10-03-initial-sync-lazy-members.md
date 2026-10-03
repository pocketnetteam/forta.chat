# Первый /sync на больших аккаунтах: lazy loading участников — план — 2026-10-03

> **Для новой сессии.** Вставить в первое сообщение:
>
> > Работаем по `docs/plans/2026-10-03-initial-sync-lazy-members.md`. Начни с этапа «…». Перед правкой сверь
> > предпосылки этапа с кодом — номера строк в плане могут устареть, ориентируйся на имена функций.
>
> Правила сборки, тестов и ревью — в `AGENTS.md`. Этот план их не повторяет.

Связанные планы: [2026-10-02-decrypt-priority-roadmap.md](2026-10-02-decrypt-priority-roadmap.md) (расшифровка
превью и загрузка ключей — тот же путь `ensureRoomCrypto` → `pcrypto.addRoom` → `prepare()`).

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

**Перед этапом C — замер (этап 0).** Весь выигрыш C зависит от того, какую долю ответа занимают `m.room.member`
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

### 5.5 Крипта при загруженных участниках — эквивалентна

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

### Этап 0. Замер (обязателен перед этапом 2)

Сохранить ответ первого `/sync` из DevTools (Response → Save) и посчитать: размер по типам событий, долю
`m.room.member`, распределение комнат по числу участников, вклад групп ≥ 50. Свой member-событие — есть ли.
Решение: если члены больших групп < ~50% ответа, C не делать, ограничиться A + B.

### Этап 1. Таймауты (A + B)

- A — запрос админам сервера.
- B — форк SDK: в `doSyncRequest` при `syncToken === null` увеличить `localTimeoutMs`. Тест на параметры
  запроса первого и инкрементального sync.

### Этап 2. `ensureRoomMembers` + точки 6.1

- Helper в `entities/matrix` (или `entities/chat/lib`): `ensureRoomMembers(roomId)` — пропуск, если
  `room.membersLoaded()` или `getJoinedMemberCount() >= 50`; дедупликация параллельных вызовов (SDK и так
  возвращает `membersPromise`, но нужен таймаут через `withTimeout`, чтобы отправка не повисла).
- `PcryptoRoomInstance`: метод, который ждёт участников и пересчитывает `users`/`usersinfo`; вызывать из
  `encryptEvent`/`encryptEventGroup`. **Не** из `prepare()` (риск 5.4).
- Остальные точки из 6.1.
- Включить флаг: `lazy_load_members: true` в `state` фильтра, `lazyLoadMembers: true` в `startClient`
  (`timeline.lazy_load_members` тоже `true` или убрать — на state он не влияет). Обновить комментарии в
  `matrix-client.ts`.
- Заменить `matrix-client-lazy-load-members.test.ts` (сейчас требует `false`).

### Этап 3. Сброс кэша при разрыве (риск 5.2)

В обработчике `Room.timelineReset` (`matrix-client.ts`, main timeline) вызывать
`room.clearLoadedMembersIfNeeded()`. Следующая отправка перезагрузит участников с сервера.

### Этап 4. Фоновая догрузка 1:1 (6.2)

После `PREPARED`, с низким приоритетом: для комнат, где `getJoinedMemberCount() <= 2` и собеседник неизвестен
(`others.length === 0`, как в `loadMissingMembers`), — `loadMembersIfNeeded` по 3–4 параллельно, с паузами.
Существующих пользователей с полным state не трогает. Кэш в IndexedDB → один раз за установку.
Группы грузятся только при открытии.

### Этап 5. Имена для пушей (6.2)

`push-service.ts` и геттеры имён в `stores.ts`: фолбэк на профили, не отправлять в native имена вида `#hash`.

---

## 8. Тесты

- `encryptEventGroup` с неполным списком ждёт загрузки и хэширует полный набор (регрессия 5.1).
- `checkPeerKeys` для нового 1:1 без member-события собеседника → после загрузки «available», не «missing»
  (регрессия бага из `ba89a056`).
- Расшифровка превью **не** вызывает `loadMembersIfNeeded` (регрессия 5.4).
- `timelineReset` → `clearLoadedMembersIfNeeded` (5.2).
- Фоновая догрузка: только 1:1 без собеседника, ограничение параллельности, пропуск при полном state.
- Исходящий звонок, удаление чата, список банов — ждут участников.
- Фильтр игнорируемых после фоновой догрузки скрывает диалог.

## 9. Ручная проверка (в `docs/manual-verification.md` в том же коммите)

- Первый вход на аккаунт с тысячами чатов: время первого sync, число попыток.
- Новый 1:1 → сразу отправить сообщение: нет ложного баннера, собеседник читает.
- Группа: кикнуть участника с другого устройства, пока этот клиент офлайн; вернуться → новое сообщение
  кикнутый не читает. Обратный случай с добавлением.
- Звонок из чата, который в этой сессии не открывали.
- Заблокированный пользователь не появляется в списке после чистой установки.
- Пуш из незапущенного приложения: в заголовке имя, не `#hash` и не Matrix ID.

## 10. Открытые вопросы

- Режет ли прокси на 60 s (этап 0 / Network).
- Поддерживает ли форк SDK simplified sliding sync (вариант D).
