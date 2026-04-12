# Сортировка чатов в Bastyon Chat — полная документация

> Документ описывает **все** механизмы сортировки, фильтрации и отображения списка чатов,
> а также работу с внешними (stream) чатами для видеотрансляций.
> Цель — дать возможность воспроизвести логику 1-в-1 в другом проекте.

---

## Содержание

1. [Архитектура данных (Vuex state)](#1-архитектура-данных-vuex-state)
2. [Сбор данных о чатах: FETCH_CHATS](#2-сбор-данных-о-чатах-fetch_chats)
3. [Сохранение в store: SET_CHATS_TO_STORE](#3-сохранение-в-store-set_chats_to_store)
4. [Сбор событий для превью: FETCH_EVENTS](#4-сбор-событий-для-превью-fetch_events)
5. [Подсчёт уведомлений: ALL_NOTIFICATIONS_COUNT](#5-подсчёт-уведомлений-all_notifications_count)
6. [Триггер обновления — Matrix sync](#6-триггер-обновления--matrix-sync)
7. [Компонент списка чатов — фильтрация и сортировка](#7-компонент-списка-чатов--фильтрация-и-сортировка)
8. [Поиск по чатам (режим глобального поиска)](#8-поиск-по-чатам-режим-глобального-поиска)
9. [Рендеринг списка — RecycleScroller](#9-рендеринг-списка--recyclescroller)
10. [Внешние чаты для видеотрансляций (stream rooms)](#10-внешние-чаты-для-видеотрансляций-stream-rooms)
11. [Известные костыли и edge-cases](#11-известные-костыли-и-edge-cases)
12. [Сводная диаграмма потока данных](#12-сводная-диаграмма-потока-данных)

---

## 1. Архитектура данных (Vuex state)

Все данные хранятся в **одном Vuex store** без модулей (`src/vuex/store.js`).

### Ключевые поля state для списка чатов

```javascript
state: {
    chats: [],           // Массив summary-объектов всех комнат
    prechats: [],        // Буфер (не используется в текущей версии)
    chatsMap: {},         // Lookup по roomId и alias → summary
    events: {},          // Превью-события для каждой комнаты (для отображения последнего сообщения)
    deletedrooms: {},    // { roomId: true } — комнаты, скрытые из списка
    force: {},           // { roomId: true } — комнаты, которые нужно принудительно обновить в chatsMap
    chatsready: false,   // Флаг: Matrix sync подготовил чаты
    readreciepts: {},    // Read receipts по комнатам
    ChatStatuses: {},    // Статусы звонков/доступа по комнатам
    chatusers: {},       // Кэш пользователей по комнатам
    allnotifications: 0, // Общее количество уведомлений
    pinchat: false,      // UI-настройка "держать чат открытым" (НЕ закреплённые чаты!)
    lastroom: null,      // Последняя открытая комната { id, time }
}
```

### Структура одного chat-summary объекта

Каждый элемент `state.chats` — это `room.summary` из Matrix SDK, расширенный полями:

```javascript
{
    roomId: "!abc123:matrix.org",     // ID комнаты
    key: "!abc123:matrix.org",        // == roomId, используется как keyField в RecycleScroller
    lastModified: 1712345678000,      // Timestamp последней активности (КЛЮЧ СОРТИРОВКИ)
    selfMembership: "join",           // Членство текущего пользователя (join/invite/leave)
    info: {
        title: "Название чата"        // Отображаемое имя комнаты
    },
    stream: false,                    // true = комната для видеотрансляции (world_readable)
    miniappchat: null,                // Метаданные мини-приложения (или null)
    // ... остальные поля из Matrix room.summary
}
```

### Getters

Геттеров для сортировки **нет**. Единственный getter для чатов — lookup по ID:

```javascript
// src/vuex/store.js, строка 91
getChatById: (state) => (id) => {
    return state.chatsMap[id];
},
```

---

## 2. Сбор данных о чатах: FETCH_CHATS

Экшен `FETCH_CHATS` — единственный источник данных для `state.chats`. Вызывается при каждом Matrix sync.

**Файл:** `src/vuex/store.js`, строка 759

```javascript
FETCH_CHATS({ commit }) {
    // 1. Берём все комнаты из Matrix SDK store
    var m_chats = f.deep(store._vm, "core.mtrx.store.rooms") || {};
    var id = store._vm.core.user.myMatrixId();

    var chats = _.map(m_chats, function (r) {
        // 2. Проверяем history_visibility для определения stream-комнат
        const hv = r.currentState.getStateEvents(
            "m.room.history_visibility",
            ""
        );

        // 3. КОСТЫЛЬ: lastModified — обработка sentinel-значения
        // Matrix SDK возвращает -9007199254740991 (Number.MIN_SAFE_INTEGER)
        // если у комнаты нет активности. В этом случае берём timestamp
        // из события m.room.member текущего пользователя.
        if (r.getLastActiveTimestamp() === -9007199254740991) {
            if (r.getMember(id)) {
                r.summary.lastModified =
                    r.getMember(id).events.member.event.origin_server_ts;
            }
        } else {
            r.summary.lastModified = r.getLastActiveTimestamp();
        }

        // 4. Заполняем дополнительные поля
        r.summary.selfMembership = r.selfMembership;
        r.summary.info = {
            title: r.name,
        };
        r.summary.key = r.summary.roomId;

        // 5. stream = true если history_visibility === "world_readable"
        r.summary.stream =
            hv?.event?.content?.history_visibility === "world_readable";

        // 6. Проверяем мини-приложение
        r.summary.miniappchat = null;
        var mnid = f.getminiappid(r.getCanonicalAlias());
        if (mnid && window.POCKETNETINSTANCE && window.POCKETNETINSTANCE.apps) {
            r.summary.miniappchat =
                window.POCKETNETINSTANCE.apps.get.installed()[mnid] || null;
        }

        return r.summary;
    });

    // 7. Коммитим в store
    commit("SET_CHATS_TO_STORE", chats);

    // 8. Загружаем участников чатов и контакты
    return store._vm.core.mtrx.kit.allchatmembers(m_chats).then((r) => {
        commit(
            "SET_CHATS_USERS",
            store._vm.core.mtrx.kit.usersFromChats(m_chats)
        );
        return store._vm.core.mtrx.kit.fillContacts(m_chats);
    });
},
```

### Ключевой момент: вычисление `lastModified`

| Условие | Источник `lastModified` |
|---------|------------------------|
| `getLastActiveTimestamp() !== -9007199254740991` | `room.getLastActiveTimestamp()` — timestamp последнего события в комнате |
| `getLastActiveTimestamp() === -9007199254740991` И есть member | `getMember(id).events.member.event.origin_server_ts` — timestamp вступления пользователя |
| `getLastActiveTimestamp() === -9007199254740991` И нет member | `lastModified` **не устанавливается** (undefined) |

---

## 3. Сохранение в store: SET_CHATS_TO_STORE

Мутация **полностью заменяет** `state.chats` и синхронизирует `state.chatsMap`.

**Файл:** `src/vuex/store.js`, строка 387

```javascript
SET_CHATS_TO_STORE(state, chats) {
    // 1. Полная замена массива
    state.chats = chats;

    var chatsMap = {};

    _.each(chats, function (chat) {
        // aid = alias (имя комнаты без символа #)
        var aid = chat.info?.title?.replace("#", "");

        // 2. КОСТЫЛЬ: Обновляем chatsMap ТОЛЬКО если:
        //    - ключа ещё нет в chatsMap
        //    - ИЛИ комната помечена в force для принудительного обновления
        // Это сделано для оптимизации — чтобы не пересоздавать Vue-реактивные объекты
        if (!state.chatsMap[chat.roomId] || state.force[chat.roomId]) {
            Vue.set(state.chatsMap, chat.roomId, chat);
        }

        if (!state.chatsMap[aid] || state.force[chat.roomId]) {
            Vue.set(state.chatsMap, aid, chat);
        }

        chatsMap[chat.roomId] = chat;
        chatsMap[aid] = chat;

        // Снимаем force-флаг после обновления
        if (state.force[chat.roomId]) {
            Vue.delete(state.force, chat.roomId);
        }
    });

    // 3. Удаляем из chatsMap комнаты, которых больше нет
    _.each(state.chatsMap, function (c, id) {
        if (!chatsMap[id]) Vue.delete(state.chatsMap, id);
    });
},
```

### Вспомогательные мутации

```javascript
// Пометить комнату для принудительного обновления в chatsMap
SET_CHAT_TO_FORCE(state, id) {
    Vue.set(state.force, id, true);
},

// Скрыть комнату из списка (soft-delete)
DELETE_ROOM(state, roomid) {
    Vue.set(state.deletedrooms, roomid, true);
},
```

---

## 4. Сбор событий для превью: FETCH_EVENTS

Экшен `FETCH_EVENTS` собирает последние события каждой комнаты для отображения **превью последнего сообщения** в списке чатов.

**Файл:** `src/vuex/store.js`, строка 812

```javascript
FETCH_EVENTS({ commit }) {
    var m_chats = f.deep(store._vm, "core.mtrx.store.rooms") || {};
    var events = {};
    var readreciepts = {};
    var chatStatuses = {};

    _.each(m_chats, function (chat) {
        events[chat.roomId] = {};

        // Берём до 50 последних timeline-событий + до 50 member-событий
        var timeline = [].concat(
            _.first([].concat(chat.timeline).reverse(), 50),
            _.first(
                [].concat(chat.currentState.getStateEvents("m.room.member"))
                    .reverse(),
                50
            )
        );

        // Фильтруем: убираем redactions, call-события, encryption, replacements
        timeline = _.filter(timeline, (e, i) => {
            if (members.length <= 2 && e.event.type === "m.room.power_levels") return false;
            if (e.event.type === "m.room.redaction") return false;
            if (e.event.type === "m.room.callsEnabled") return false;
            if (e.event.type === "m.call.replaces") return false;
            if (e.event.type === "m.call.select_answer") return false;
            if (e.event.type === "m.call.negotiate") return false;
            if (e.event.type === "m.call.candidates") return false;
            if (e.event.type === "m.call.asserted_identity") return false;
            if (e.event.type === "m.room.encryption") return false;
            // ... + фильтрация request_calls_access и m.replace
            return true;
        });

        // СОРТИРОВКА СОБЫТИЙ: по origin_server_ts, новые первыми
        timeline = _.sortBy(timeline, function (event) {
            return -event.event.origin_server_ts;
        });

        events[chat.roomId] = { timeline: timeline };
    });

    commit("SET_EVENTS_TO_STORE", events);
    commit("SET_READ_TO_STORE", readreciepts);
    commit("SET_CHAT_STATUSES_ALL", chatStatuses);
},
```

Результат: `state.events[roomId].timeline[0]` — это **последнее событие**, которое отображается как превью в списке чатов.

---

## 5. Подсчёт уведомлений: ALL_NOTIFICATIONS_COUNT

Мутация считает общее количество непрочитанных сообщений, **исключая stream-комнаты**.

**Файл:** `src/vuex/store.js`, строка 324

```javascript
ALL_NOTIFICATIONS_COUNT(state, rooms) {
    var n = new Date();

    // 1. Считаем непринятые инвайты (кроме stream-комнат и заблокированных)
    var count = _.filter(rooms, (room) => {
        if (room._selfMembership === "invite" && !room.summary.stream) {
            var users = store._vm.core.mtrx.anotherChatUsers(room);

            // Не считаем инвайт от заблокированного пользователя
            if (
                users.length == 1 &&
                store._vm.core.mtrx.blockeduser(users[0].userId)
            ) {
                return false;
            }

            // Инвайт считается только если он моложе 24 часов
            if (f.date.addseconds(new Date(room.summary.lastModified), 86400) > n)
                return true;
        }
    });

    // 2. Суммируем unread notification count по всем комнатам
    //    КРОМЕ stream-комнат (stream не влияет на бейдж)
    state.allnotifications =
        _.reduce(
            rooms,
            (s, chat) => {
                return (
                    s +
                    (!chat.summary.stream
                        ? chat.getUnreadNotificationCount() || 0
                        : 0)
                );
            },
            0
        ) + count.length;

    // 3. Вызываем callback во внешнем (родительском) приложении
    var external =
        f.deep(store, "_vm.core.external.clbks.ALL_NOTIFICATIONS_COUNT") || {};
    _.each(external, function (e) {
        e(state.allnotifications);
    });
},
```

---

## 6. Триггер обновления — Matrix sync

Все обновления списка чатов запускаются при получении sync-события от Matrix.

**Файл:** `src/application/mtrx.js`, строка 580

```javascript
this.client.on("sync", (state, prevState, res) => {
    if (state === "PREPARED") {
        console.log("PREPARED");
    }

    // Устанавливаем флаг готовности
    this.setready();

    // Обновляем список чатов (пересобираем summary)
    this.core.store.dispatch("FETCH_CHATS").then(r => {});

    // Обновляем превью-события
    this.core.store.dispatch("FETCH_EVENTS");

    // Пересчитываем уведомления
    this.core.store.commit("ALL_NOTIFICATIONS_COUNT", this.client.getRooms());
});
```

### Также при получении нового события в timeline:

```javascript
// src/application/mtrx.js, строка 546
this.client.on("Room.timeline", (message, member) => {
    if (!this.chatsready) return;
    if (!message.event.content) return;

    // Реакции обновляют только events, не весь список чатов
    if (message.event.type === "m.reaction") {
        this.core.store.dispatch("FETCH_EVENTS");
        this.core.store.commit("UPDATE_TIMESTAMP", Date.now());
        // КОСТЫЛЬ: мутации UPDATE_TIMESTAMP нет в store.js — commit ничего не делает
        return;
    }

    // Для обычных сообщений — уведомление
    if (message.getSender() !== userId) {
        var m_chat = this.core.mtrx.client.getRoom(message.event.room_id);
        // ... отправка уведомления через notifier
    }
});
```

---

## 7. Компонент списка чатов — фильтрация и сортировка

Это **центральное место** сортировки. Computed property `chats` в компоненте **перекрывает** (shadows) одноимённое поле из `mapState`, добавляя фильтрацию и сортировку.

**Файл:** `src/components/chats/list/index.js`, строка 127

```javascript
// ВАЖНО: Это computed внутри mapState. Оно получает state как аргумент,
// но результат полностью заменяет state.chats для шаблона этого компонента.

chats: function (state) {
    var self = this;
    var chats = [];

    _.each(state.chats, (chat) => {

        // ═══════════════════════════════════════════════════════
        // ФИЛЬТР 1: Автоудаление устаревших stream-комнат (TTL = 3 дня)
        // ═══════════════════════════════════════════════════════
        if (chat.stream) {
            const
                m_chat = this.core.mtrx.client.getRoom(chat.roomId),
                current = Date.now(),
                expire = (() => {
                    const
                        id = this.$store._vm.core.user.myMatrixId(),
                        // Тот же костыль с sentinel-значением, что и в FETCH_CHATS
                        last = new Date((() => {
                            if (m_chat.getLastActiveTimestamp() === -9007199254740991) {
                                if (m_chat.getMember(id)) {
                                    return m_chat.getMember(id).events.member.event.origin_server_ts;
                                }
                            } else {
                                return m_chat.getLastActiveTimestamp();
                            }
                        }));

                    // Добавляем 3 дня к последней активности
                    last.setDate(last.getDate() + 3);
                    return last.getTime();
                })(),
                outdated = current > expire;

            // Если прошло > 3 дней — покидаем комнату и забываем
            if (outdated) {
                this.core.mtrx.client.leave(chat.roomId).then(() => {
                    this.core.mtrx.client
                        .forget(chat.roomId, true)
                        .catch(() => {});
                    // КОСТЫЛЬ: commit здесь не в скоупе (нет this.$store.commit),
                    // может не работать. В теории должно быть this.$store.commit(...)
                    commit("DELETE_ROOM", chat.roomId);
                });
            }
        }

        // ═══════════════════════════════════════════════════════
        // ФИЛЬТР 2: Исключаем удалённые и stream-комнаты
        // ═══════════════════════════════════════════════════════
        if (this.deletedrooms[chat.roomId] || chat.stream) return;

        // КОСТЫЛЬ: вызов tetatetchat с this.m_chat, но m_chat не определён
        // в этом компоненте. Скорее всего dead code или ошибка.
        this.core.mtrx.kit.tetatetchat(this.m_chat);

        // ═══════════════════════════════════════════════════════
        // ФИЛЬТР 3: Исключаем чаты с единственным заблокированным пользователем
        // ═══════════════════════════════════════════════════════
        var users = this.core.mtrx.chatUsersInfo(
            chat.roomId,
            "anotherChatUsers"
        );

        if (
            users.length === 1 &&
            users[0] &&
            self.core.mtrx.client.isUserIgnored(
                f.getMatrixIdFull(users[0].id, self.core.domain)
            )
        ) {
            return; // Пропускаем чат с заблокированным пользователем
        } else {
            chats.push(chat);
        }
    });

    // ═══════════════════════════════════════════════════════
    // СОРТИРОВКА: по lastModified, от новых к старым
    // ═══════════════════════════════════════════════════════
    chats = _.sortBy(chats, function (o) {
        return o.lastModified;
    }).reverse();

    return chats;
},
```

### Итого порядок фильтрации и сортировки:

```
state.chats (все комнаты из Matrix)
  │
  ├─ [ФИЛЬТР] stream === true → пропускаем (+ auto-leave если > 3 дней)
  ├─ [ФИЛЬТР] deletedrooms[roomId] === true → пропускаем
  ├─ [ФИЛЬТР] единственный участник заблокирован → пропускаем
  │
  └─ _.sortBy(chats, o => o.lastModified).reverse()
     │
     └─ Результат: массив чатов, отсортированный по lastModified DESC
```

### Что НЕ влияет на сортировку

| Фактор | Влияние на сортировку |
|--------|----------------------|
| Непрочитанные сообщения | **Нет** — влияют только на бейдж |
| "Закреплённые" чаты | **Нет** — `pinchat` — это настройка UI, не закрепление комнат |
| Тип комнаты (групповой/личный) | **Нет** |
| Избранные (m.tag favourites) | **Нет** — не реализовано |

---

## 8. Поиск по чатам (режим глобального поиска)

Когда пользователь вводит текст в поиск, отображается компонент `AllContacts` вместо обычного списка.

### Переключение режимов

```javascript
// src/components/chats/list/index.vue
<div class="chatswrapper" v-if="!globalsearch">
    <RecycleScroller ... :items="chats" ... />
</div>
<div v-else class="searchresults">
    <AllContacts
        :chats="chats"
        :search="globalsearch"
        @clearsearch="() => searchall('')"
    />
</div>
```

### Сортировка в режиме поиска — по релевантности

**Файл:** `src/components/contacts/all/index.js`, строка 107

```javascript
filteredChats() {
    let chats = this.chats;

    if (this.search) {
        let mc = _.filter(
            _.map(chats, (c) => {
                const users = this.core.mtrx.chatUsersInfo(
                        c.roomId,
                        "anotherChatUsers"
                    ),
                    mChat = this.core.mtrx.client.getRoom(c.roomId),
                    // Склеиваем имена всех участников в одну строку
                    userNameString = _.reduce(
                        users,
                        (m, u) => m + u.name.toLowerCase(),
                        ""
                    );

                let chatName = "";

                // Для публичных чатов берём имя из m.room.name
                if (
                    mChat &&
                    mChat.getJoinRule() === "public" &&
                    mChat.currentState.getStateEvents("m.room.name", "").length > 0
                ) {
                    chatName = mChat.currentState
                        .getStateEvents("m.room.name", "")[0]
                        ?.getContent().name;
                }

                // Фоллбэк: имя комнаты из SDK, но не если начинается с #
                if (!chatName) {
                    chatName = mChat.name;
                    if (chatName[0] === "#") chatName = "";
                }

                // Формула релевантности: длина_запроса / длина_строки
                const uString = (chatName + userNameString).toLowerCase();
                let point = 0;

                if (uString.includes(this.search)) {
                    point = this.search.length / uString.length;
                }

                return {
                    chat: mChat,
                    point,
                };
            }),
            (cc) => cc.point  // _.filter оставляет только point > 0
        );

        // Сортировка: чем выше point, тем выше в списке
        mc = _.sortBy(mc, (cc) => cc.point).reverse();
        chats = mc.map((c) => c.chat.summary);
    }

    return chats;
},
```

### Формула релевантности

```
point = search.length / (chatName + userNames).length
```

Чем короче полное имя и чем длиннее поисковый запрос — тем выше `point`.

---

## 9. Рендеринг списка — RecycleScroller

Список чатов использует виртуализированный скроллер `vue-virtual-scroller`.

**Файл:** `src/components/chats/list/index.vue`

```html
<RecycleScroller
    page-mode
    class="scroller"
    :items="chats"
    :item-size="pocketnet ? 60 : 70"
    keyField="key"
    :buffer="400"
    @update="onScrollerResize"
    ref="scroller"
>
    <template v-slot="{ item }">
        <div
            class="card-content"
            :class="[activeRoomId === item.roomId && 'active']"
            :chatkey="item.key"
            @click="(e) => itemClick(item)"
        >
            <preview :chat="item" />
        </div>
    </template>
</RecycleScroller>
```

### Ключевые параметры:

| Параметр | Значение | Описание |
|----------|----------|----------|
| `items` | `chats` (computed) | Отфильтрованный и отсортированный массив |
| `item-size` | 60 / 70 px | Высота одной строки (зависит от режима pocketnet) |
| `keyField` | `"key"` | Используется `chat.key` (== `roomId`) |
| `buffer` | 400 px | Буфер пре-рендеринга |

### Превью чата (компонент preview)

Каждая строка списка — компонент `chats/preview`, который показывает:
- Имя чата
- Время последнего сообщения (из `chat.lastModified`)
- Превью последнего события (из `state.events[roomId].timeline[0]`)

---

## 10. Внешние чаты для видеотрансляций (stream rooms)

### 10.1. Что такое stream room

Stream room — это комната Matrix с `history_visibility: "world_readable"`. Такие комнаты используются как чаты рядом с видеотрансляциями и **не отображаются в общем списке чатов**.

### 10.2. Как определяется stream-комната

**Файл:** `src/vuex/store.js`, внутри `FETCH_CHATS`:

```javascript
const hv = r.currentState.getStateEvents("m.room.history_visibility", "");

r.summary.stream =
    hv?.event?.content?.history_visibility === "world_readable";
```

**Единственный критерий:** `m.room.history_visibility` === `"world_readable"` → `stream: true`.

### 10.3. Создание stream-комнаты

**Файл:** `src/application/index.js`, строка 829

```javascript
createStreamRoom(name) {
    return this.mtrx.client
        .createRoom({
            // Alias с /hidden для "скрытого" имени
            room_alias_name: `${f.makeid()}/hidden`,
            // Публичная комната
            visibility: "public",
            invite: [],
            // Имя с @ для идентификации
            name: `@${name}`,

            initial_state: [
                {
                    // Гости могут присоединяться
                    type: "m.room.guest_access",
                    state_key: "",
                    content: {
                        guest_access: "can_join",
                    },
                },
            ],
        })
        .then((chat) => {
            // Устанавливаем retention (хранение) на 20 лет
            this.mtrx.client.setRoomRetention(chat.room_id, {
                max_lifetime: "20y",
            });

            // Разрешаем гостям присоединяться и читать
            return this.mtrx.client
                .setGuestAccess(chat.room_id, {
                    allowJoin: true,
                    allowRead: true,  // Это устанавливает world_readable → stream: true
                })
                .then(() => {
                    return Promise.resolve(chat.room_id);
                });
        });
}
```

### 10.4. Удаление stream-комнаты

```javascript
// src/application/index.js, строка 872
removeStreamRoom(roomId) {
    return this.mtrx.client.removeRoom(roomId);
}
```

### 10.5. Встраивание stream-чата рядом с видео

**Файл:** `src/application/index.js`, строка 384

```javascript
renderChatToElement = function (element, roomid, p) {
    return this.exporter.chat(element, roomid, p);
};
```

Вызов из родительского приложения:

```javascript
// Пример из public/index.html
window.matrixchat.mtrx.core.renderChatToElement(
    document.querySelector('#exported div'),
    roomId,
    {
        style: 'stream',       // Режим отображения "стрим"
        videoUrl: '...',       // URL видео
        videoMeta: null,       // Метаданные видео (загружаются автоматически)
    }
);
```

### 10.6. Exporter — загрузка stream-чата

**Файл:** `src/application/exporter.js`, строка 45

```javascript
async chat(el, roomId, p) {
    await this.core?.mtrx?.waitchats();

    // Для stream-стиля загружаем метаданные видео
    if (!p.videoMeta && p.style === "stream") {
        await window.POCKETNETINSTANCE?.platform?.sdk?.videos?.info([p.videoUrl])
            .then(() => window.parseVideo(p.videoUrl))
            .then(meta => {
                if (meta?.type === "peertube") {
                    meta = _.clone(window.peertubeglobalcache[meta.id]);
                    p.videoMeta = meta;
                }
            });
    }

    const chat = this.core.vm.$store.state.chatsMap[roomId];

    if (chat) {
        // Комната уже в store — создаём Vue-инстанс и монтируем
        const instance = new chatConstructor({
            data: { chat, ...p },
        });
        instance.$options.shadowRoot = el.ownerDocument.body;
        instance.$mount(el);
        // ...
        return Promise.resolve(instance);
    } else if (typeof this.core?.mtrx?.client?.peekInRoom !== "undefined") {
        // КОСТЫЛЬ: Комнаты нет в store — делаем peekInRoom
        // и принудительно добавляем с stream: true
        await this.core.mtrx.client.peekInRoom(roomId)
            .then(room => {
                if (!room) return Promise.reject("missing:chat");

                this.core.vm.$store.commit(
                    "SET_CHATS_TO_STORE",
                    this.core.vm.$store.state.chats.concat([
                        Object.assign(room.summary, { stream: true })
                    ])
                );
            });

        // Рекурсивный вызов — теперь комната есть в store
        return this.chat.apply(this, arguments);
    }
}
```

### 10.7. Фильтрация stream-комнат из общего списка

**Где:** `src/components/chats/list/index.js`, computed `chats`

```javascript
// Строка 167 — главный фильтр
if (this.deletedrooms[chat.roomId] || chat.stream) return;
```

Stream-комнаты **всегда** исключаются из списка. Дополнительно — автоочистка:

```javascript
// Строки 133-164 — автоматическое удаление устаревших stream-комнат
if (chat.stream) {
    // Вычисляем expire = lastActive + 3 дня
    // Если current > expire → leave + forget + DELETE_ROOM
}
```

### 10.8. Stream-комнаты не создают уведомления

**Файл:** `src/application/notifier.js`, строка 150

```javascript
// В методе event():
if (chat?.summary?.stream) return;  // Пропускаем уведомления для stream-комнат
```

**Файл:** `src/vuex/store.js`, `ALL_NOTIFICATIONS_COUNT`:

```javascript
// Не считаем unread для stream-комнат
(!chat.summary.stream ? chat.getUnreadNotificationCount() || 0 : 0)

// Не считаем инвайты в stream-комнаты
if (room._selfMembership === "invite" && !room.summary.stream) { ... }
```

### 10.9. В stream-режиме не отправляются read receipts

**Файл:** `src/components/chat/list/index.js`, строка 566

```javascript
readEvent: function (event) {
    if (this.streamMode) return;  // Не отправляем read receipt в stream-чате
    // ...
    this.core.mtrx.client.sendReadReceipt(event);
},
```

### 10.10. Вход в stream-чат блокируется если трансляция не live

**Файл:** `src/components/chat/join/index.js`, строка 51

```javascript
if (this.streamMode && !this.videoMeta?.isLive) return;
```

### 10.11. Полный lifecycle stream-комнаты

```
1. Создание:
   createStreamRoom(name)
   → createRoom({ visibility: "public", guest_access: "can_join" })
   → setRoomRetention(20y)
   → setGuestAccess({ allowJoin: true, allowRead: true })
   → roomId

2. Встраивание:
   renderChatToElement(element, roomId, { style: "stream" })
   → exporter.chat()
   → peekInRoom() если комнаты нет в store
   → SET_CHATS_TO_STORE с { stream: true }
   → монтирование Vue-компонента

3. Фильтрация из списка:
   computed chats: if (chat.stream) return; // всегда пропускается

4. Автоочистка (TTL 3 дня):
   Если lastActive + 3 дня < now:
   → leave(roomId)
   → forget(roomId)
   → DELETE_ROOM(roomId)

5. Удаление:
   removeStreamRoom(roomId)
   → client.removeRoom(roomId)
```

---

## 11. Известные костыли и edge-cases

### 11.1. Sentinel-значение `getLastActiveTimestamp()`

Matrix SDK возвращает `-9007199254740991` (`Number.MIN_SAFE_INTEGER`) для комнат без активности. Код обрабатывает это **дважды** (в `FETCH_CHATS` и в computed `chats`), используя timestamp из `m.room.member` как fallback.

### 11.2. `commit("DELETE_ROOM", ...)` внутри computed

В computed `chats` (строка 162) вызывается `commit("DELETE_ROOM", ...)` — но `commit` не находится в скоупе computed property. Должно быть `this.$store.commit(...)`. Потенциально этот код не работает.

### 11.3. `UPDATE_TIMESTAMP` — несуществующая мутация

В `mtrx.js` при обработке реакций вызывается `this.core.store.commit("UPDATE_TIMESTAMP", Date.now())`, но мутации `UPDATE_TIMESTAMP` нет в `store.js`. Commit ничего не делает.

### 11.4. `this.m_chat` в computed `chats` — undefined

В строке 169 вызывается `this.core.mtrx.kit.tetatetchat(this.m_chat)`, но `m_chat` не определён в компоненте `chats/list`. Скорее всего dead code.

### 11.5. Computed property с side effects

Computed `chats` выполняет побочные эффекты: `leave()`, `forget()`, `DELETE_ROOM`. Vue computed properties не должны иметь side effects — это антипаттерн. Автоочистка stream-комнат работает как побочный эффект при пересчёте списка.

### 11.6. `SET_CHATS_TO_STORE` — оптимизация через `force`

`chatsMap` обновляется через `Vue.set` **только** для новых комнат или помеченных в `force`. Это оптимизация для избежания лишних Vue-реактивных обновлений, но может приводить к "залипанию" старых данных если не вызвать `SET_CHAT_TO_FORCE`.

### 11.7. Двойное маппирование `chats` в `mapState`

Компонент использует `...mapState(["chats"])` (строка 100) **и** определяет computed `chats` (строка 127) внутри того же `mapState`. Computed property перекрывает маппированное значение. Это работает, но неочевидно и может сбить с толку.

### 11.8. `onScrollerResize` — не определён

В шаблоне `@update="onScrollerResize"`, но метод `onScrollerResize` не определён в `index.js`. Событие уходит в void.

---

## 12. Сводная диаграмма потока данных

```
Matrix Server
    │
    ▼
Matrix SDK (client.on("sync"))
    │
    ├─► FETCH_CHATS (action)
    │       │
    │       ├─ Итерация по core.mtrx.store.rooms
    │       ├─ Вычисление lastModified (+ sentinel workaround)
    │       ├─ Определение stream (history_visibility === "world_readable")
    │       ├─ Заполнение info, key, miniappchat
    │       │
    │       └─► SET_CHATS_TO_STORE (mutation)
    │               │
    │               ├─ state.chats = [...] (полная замена)
    │               └─ state.chatsMap = синхронизация по roomId и alias
    │
    ├─► FETCH_EVENTS (action)
    │       │
    │       ├─ Фильтрация timeline-событий
    │       ├─ Сортировка по -origin_server_ts
    │       │
    │       └─► SET_EVENTS_TO_STORE (mutation)
    │               └─ state.events[roomId].timeline = [...]
    │
    └─► ALL_NOTIFICATIONS_COUNT (mutation)
            └─ state.allnotifications = sum(unread, исключая stream) + invites

            ┌─────────────────────────────────────┐
            │                                     │
            ▼                                     │
    Компонент chats/list                          │
    computed chats(state)                          │
            │                                     │
            ├─ _.each(state.chats)                │
            │     ├─ if (chat.stream) → SKIP      │
            │     │    └─ if (outdated) → leave/forget/DELETE_ROOM
            │     ├─ if (deletedrooms[id]) → SKIP │
            │     ├─ if (ignored user) → SKIP     │
            │     └─ chats.push(chat)             │
            │                                     │
            ├─ _.sortBy(chats, o.lastModified)    │
            │   .reverse()                        │
            │                                     │
            └─► RecycleScroller                   │
                  ├─ :items="chats"               │
                  ├─ keyField="key" (== roomId)   │
                  └─ <preview :chat="item" />     │
                        │                         │
                        ├─ chatName               │
                        ├─ chatTime (lastModified) │
                        └─ event (events[roomId].timeline[0])
```

---

## Чеклист для воспроизведения в другом проекте

1. **Vuex state:** создать `chats`, `chatsMap`, `events`, `deletedrooms`, `force`, `chatsready`
2. **FETCH_CHATS:** на каждый sync собирать summary из Matrix rooms, вычислять `lastModified` с обработкой sentinel-значения, определять `stream` по `history_visibility`
3. **SET_CHATS_TO_STORE:** полная замена `chats`, инкрементальное обновление `chatsMap` через `Vue.set` с системой `force`
4. **FETCH_EVENTS:** собирать timeline-превью для каждой комнаты, сортировать по `-origin_server_ts`
5. **Computed chats:** фильтрация (stream, deleted, ignored) → сортировка по `lastModified` DESC
6. **RecycleScroller:** виртуализированный список с `keyField="key"`
7. **Stream rooms:** создание через `createRoom` + `setGuestAccess({ allowRead: true })`, фильтрация по `chat.stream`, TTL 3 дня, без уведомлений, без read receipts
8. **Поиск:** переключение на `AllContacts` с сортировкой по `point = search.length / string.length`
