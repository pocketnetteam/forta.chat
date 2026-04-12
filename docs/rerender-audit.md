# Аудит перерисовок интерфейса (Re-render Audit)

> **Проект:** Forta.Chat — Vue 3 + Pinia + Dexie (IndexedDB) + Matrix SDK  
> **Дата:** 12 апреля 2026  
> **Цель:** Подробная карта всех источников перерисовок UI для диагностики визуальных "тормозов"

---

## Содержание

1. [Архитектура реактивности (общий обзор)](#1-архитектура-реактивности)
2. [Экран «Список чатов» (Sidebar)](#2-экран-список-чатов-sidebar)
3. [Экран «Открытый чат» (ChatWindow)](#3-экран-открытый-чат-chatwindow)
4. [Pinia-сторы и каскадная реактивность](#4-pinia-сторы-и-каскадная-реактивность)
5. [Таймеры, наблюдатели, слушатели — полный реестр](#5-таймеры-наблюдатели-слушатели)
6. [Известные anti-patterns и проблемные места](#6-известные-anti-patterns)
7. [Рекомендуемые направления оптимизации](#7-рекомендуемые-направления-оптимизации)

---

## 1. Архитектура реактивности

### Путь данных (Data Flow)

```
Matrix SDK (sync/events)
    ↓
stores.ts (onTimeline / onReceipt / onTyping)
    ↓
EventWriter → Dexie (IndexedDB)
    ↓
┌─ observeRoomChanges (Dexie hooks) → applyDexieDeltas → patchSortedRooms → _sortedRoomsRef
│  (для списка чатов)
│
└─ useLiveQuery (Dexie liveQuery) → dexieMessages → activeMessages computed
   (для открытого чата)
    ↓
Vue computed chain → template → DOM
```

### Ключевые принципы текущей архитектуры

- **Dexie = single source of truth** — данные пишутся в IndexedDB, оттуда читаются через `liveQuery` и hooks
- **`shallowRef` + `triggerRef`** — основные хранилища (`rooms`, `messages`, `_sortedRoomsRef`) используют `shallowRef` для избежания глубокого проксирования; мутации «на месте» требуют ручного `triggerRef()`
- **Мемоизация** — `activeMessages` пытается переиспользовать объекты `Message` при неизменных данных
- **`v-memo`** — в `MessageList` используется для пропуска перерисовки конкретных message bubble

---

## 2. Экран «Список чатов» (Sidebar)

### 2.1. Дерево компонентов

```
ChatSidebar.vue
├── ConnectionStatusHeader
├── FolderTabs (All / Personal / Groups / Invites / Channels)
├── SwipeableTabs (горизонтальный свайп между фильтрами)
│   ├── ContactList (filter="all")     ← RecycleScroller
│   ├── ContactList (filter="personal")
│   ├── ContactList (filter="groups")
│   ├── ContactList (filter="invites")
│   └── ChannelList                    ← RecycleScroller
├── ContactSearch (при активном поиске)
└── BottomTabBar
```

### 2.2. Что вызывает перерисовку списка чатов

#### A. Входящее сообщение (самый частый сценарий)

**Путь:**
1. Matrix SDK `Room.timeline` → `stores.ts:onTimeline` → `chatStore.handleTimelineEvent`
2. `handleTimelineEvent` → `EventWriter.writeMessage` → запись в Dexie таблицу `messages` + обновление `rooms` (lastMessage, unreadCount, updatedAt)
3. Dexie hook `updating` на таблице `rooms` → `observeRoomChanges` callback
4. `queueMicrotask` коалесцирует → `applyDexieDeltas(changes)`
5. `patchSortedRooms` — **O(n) копия** всего массива `_sortedRoomsRef` + binary search вставка
6. `_sortedRoomsRef.value = arr` — **новая ссылка на массив**

**Каскад инвалидации:**
- `sortedRooms` computed → все потребители
- `ContactList.roomNameMap` — **итерирует ВСЕ комнаты** для построения карты имён
- `ContactList.unresolvedRoomSet` — **итерирует ВСЕ комнаты**
- `ContactList.allFilteredRooms` — **итерирует ВСЕ комнаты** + фильтрация + маппинг
- `ContactList.filteredRooms` — slice по `displayLimit`
- `FolderTabs.visibleTabs` — зависит от `chatStore.inviteCount` (который тоже `.filter()` по `sortedRooms`)
- `BottomTabBar` — зависит от `chatStore.totalUnread` (итерация `dexieRoomMap`)
- `RecycleScroller` получает новый `:items` → пересчитывает видимые ячейки

**Оценка тяжести:** При 500+ чатах — 4-5 полных итераций по массиву на КАЖДОЕ входящее сообщение.

#### B. Приход нового имени пользователя (Profile load)

**Путь:**
1. `userStore.setUser()` или `setUsers()` → `triggerRef(users)` (с debounce 100мс для batch)
2. `ContactList.roomNameMap` инвалидируется → пересчитывает имена всех комнат
3. Оптимизация: если имена не изменились, возвращается старая ссылка (строки 87-89 ContactList.vue)
4. Если хотя бы одно имя изменилось → новая ссылка `roomNameMap` → `allFilteredRooms` → `filteredRooms`

**Проблема:** При начальной загрузке имена приходят батчами. Каждый `triggerRef(users)` запускает цепочку. Debounce 100мс помогает, но при быстрой последовательности загрузок всё равно несколько волн.

#### C. Изменение pin/mute статуса

**Путь:**
1. `togglePinRoom` → `pinnedRoomIds.value = new Set(...)` → новая ссылка
2. Watcher `[rooms, pinnedRoomIds]` с **`flush: "sync"`** — запускается **синхронно** в том же тике
3. `scheduleFullSortedRebuild()` → `setTimeout(50мс)` → `fullRebuildSortedRoomsAsync()`
4. **Полная пересортировка** всех комнат → `_sortedRoomsRef.value = mapped`
5. Весь каскад из пункта A

#### D. Typing indicator в 1:1 чатах

- Typing НЕ хранится в Dexie, только в Pinia (`typing` ref в chat-store)
- Но `ChatRoomRow` читает `chatStore.getTypingUsers(room.id)` в шаблоне
- Каждое typing-событие вызывает ре-рендер **конкретной строки** (не всего списка)

**Потенциальная проблема:** Если `getTypingUsers` — не computed, а обычная функция, Vue трекает зависимости на уровне вызова. Нужно проверить.

#### E. Переключение вкладки (All → Personal → Groups)

1. `activeFilter` меняется → `allFilteredRooms` пересчитывается
2. `displayLimit` сбрасывается
3. `nextTick(loadVisibleRooms)` — загрузка профилей видимых комнат

#### F. Scroll в списке чатов

1. Scroll event → debounce 150мс → `loadVisibleRooms` + `loadMoreRooms` (pagination)
2. `displayLimit` увеличивается → `filteredRooms` расширяется → новые элементы в `RecycleScroller`
3. `loadProfilesForRoomIds` → сетевые запросы → `userStore.setUsers` → потенциально roomNameMap

### 2.3. `ChatRoomRow.vue` — изоляция строки

Каждая строка — отдельный компонент с собственными reactive-зависимостями:

| Зависимость | Когда меняется | Затрагивает строку? |
|-------------|----------------|---------------------|
| `props.room` (из sortedRooms) | Каждый patchSortedRooms | Да, если объект заменён |
| `chatStore.activeRoomId` | Переключение чата | Все строки (highlight) |
| `chatStore.pinnedRoomIds` | Pin toggle | Все строки (pin icon) |
| `chatStore.mutedRoomIds` | Mute toggle | Все строки (mute icon) |
| `chatStore.getTypingUsers` | Typing event | Конкретная строка |
| `chatStore.messages[room.id]` | Новое сообщение | Конкретная строка (preview) |
| `chatStore.dexieRoomMap` | Room update | Конкретная строка (preview fallback) |
| `selectionStore.isSelectionMode` | Long-press | Все строки |
| `selectionStore.isSelected(id)` | Selection toggle | Конкретная строка |

**Проблема:** `activeRoomId`, `pinnedRoomIds`, `mutedRoomIds`, `selectionStore.isSelectionMode` — при изменении вызывают ре-рендер **ВСЕХ видимых строк**, т.к. каждая строка подписана на эти значения.

### 2.4. `ConnectionStatusHeader` + `useSyncStatus`

- Module-level `rawStatus` ref обновляется из Matrix sync callback
- `useDebouncedStatus` добавляет задержки показа/скрытия (несколько `setTimeout`)
- `staleTimer` — 30с/60с проверка "зависшего" состояния
- При каждом изменении статуса — ре-рендер header

---

## 3. Экран «Открытый чат» (ChatWindow)

### 3.1. Дерево компонентов

```
ChatWindow.vue
├── Header (title, typing, subtitle, peer keys)
├── PinnedBar (закреплённые сообщения)
├── MessageList.vue ← ОСНОВНОЙ КОМПОНЕНТ
│   └── ChatVirtualScroller.vue (column-reverse, НЕ windowed)
│       └── v-for item in reversedItems
│           ├── DateSeparator
│           ├── UnreadBanner
│           ├── SystemMessage
│           ├── MessageBubble.vue (v-memo)
│           │   ├── MessageContent.vue
│           │   ├── MessageStatusIcon.vue
│           │   ├── ReactionRow.vue
│           │   └── MediaAttachments
│           └── TypingBubble.vue
├── MessageInput.vue
│   ├── ReplyPreview / EditPreview / ForwardPreview
│   ├── MentionAutocomplete
│   ├── LinkPreview
│   └── MediaUpload panels
└── SelectionBar (в режиме выделения)
```

### 3.2. Что вызывает перерисовку в открытом чате

#### A. Входящее сообщение (в ТЕКУЩЕМ чате)

**Путь:**
1. Matrix `Room.timeline` → `handleTimelineEvent` → `EventWriter.writeMessage`
2. Dexie `messages` table update → **`liveQuery`** re-fires
3. `dexieMessages.value = newArray` (shallowRef) → `activeMessages` computed invalidated
4. `activeMessages` (строки 809-879 chat-store.ts):
   - Сравнивает `raw === _prevDexieInput` — **ложь** (новый массив) → полный `.map()`
   - Для каждого LocalMessage: ищет предыдущий Message по id, проверяет shallow equality
   - Если поля не изменились → переиспользует старый `Message` объект
   - Для нового сообщения → создаёт новый `Message`
5. `virtualItems` computed (строки 229-301 MessageList.vue):
   - Итерирует ВСЕ `activeMessages`
   - Генерирует date separators, unread banner, typing indicator
   - Возвращает новый массив `VirtualItem[]`
6. `reversedItems` computed (строки 305-312):
   - Реверсирует массив для column-reverse layout
   - Всегда новый массив
7. `ChatVirtualScroller` получает новые `items` → Vue diff → DOM update

**Оценка тяжести:**
- 3 полных итерации массива сообщений (activeMessages + virtualItems + reversedItems)
- При 100+ сообщениях в окне — заметная работа
- `v-memo` на MessageBubble помогает, но `virtualItems` и `reversedItems` всё равно пересоздаются полностью

#### B. Входящее сообщение (в ДРУГОМ чате)

- `liveQuery` привязан к `activeRoomId` → **не перезапускается** для других комнат
- Но `patchSortedRooms` обновляет `sortedRooms` → sidebar перерисовывается
- Если sidebar и chat видны одновременно — двойная работа

#### C. Read receipt (кто-то прочитал ваше сообщение)

**Путь:**
1. `Room.receipt` → `handleReceiptEvent` → `EventWriter.writeReceipt`
2. `roomRepo.updateOutboundWatermark` → Dexie room update
3. `observeRoomChanges` → `applyDexieDeltas` → `_dexieRoomMapVersion++`
4. `activeRoomOutboundWatermark` computed инвалидируется
5. `activeMessages` computed: `watermarkChanged = true` → **ВСЕ собственные сообщения** пересоздаются (`localToMessages`) вместо переиспользования
6. Каскад: `virtualItems` → `reversedItems` → DOM diff

**Проблема:** Один read receipt пересоздаёт `Message` объекты для **всех** собственных сообщений в окне. `v-memo` может спасти (проверяет `status`), но сами computed пересчитываются.

#### D. Reaction на сообщение

**Путь:**
1. Matrix event → `handleTimelineEvent` (reaction) → Dexie message update (reactions field)
2. `liveQuery` → новый массив `dexieMessages`
3. `activeMessages`: `reactionsShallowEqual` — **ложь** для изменённого сообщения → новый `Message` объект
4. `v-memo` ловит изменение `item.message.reactions` → перерисовка `MessageBubble`

**Хорошо:** Точечная перерисовка только затронутого bubble.  
**Плохо:** Весь `activeMessages` / `virtualItems` / `reversedItems` пересчитывается ради одной реакции.

#### E. Typing indicator

**Путь:**
1. Matrix `m.typing` или `com.bastyon.typing` to-device → `onTyping`
2. `chatStore.setTypingUsers(roomId, users)` → обновление `typing` ref
3. `MessageList.typingText` computed → `typingNames` computed
4. `virtualItems` — добавляет/убирает элемент `type: 'typing'`
5. `reversedItems` пересоздаётся

**Проблема:** Typing indicator мерцает → `virtualItems` полностью пересоздаётся при каждом вкл/выкл typing. А это **итерация всех сообщений** в computed.

#### F. Scroll вверх (подгрузка истории)

**Путь:**
1. Scroll → RAF throttle → `onScrollThrottled`
2. Near top → `expandMessageWindow()` → `messageWindowSize += 50`
3. Debounce 200мс → `debouncedMessageWindowSize` → `useLiveQuery` перезапускается
4. Новый Dexie query с бОльшим limit → новый массив → весь computed chain

#### G. Переключение комнаты

**Путь (тяжёлый, много последовательных шагов):**
1. `setActiveRoom(roomId)` — flush EventWriter, reset messageWindowSize, bump `_liveQueryGen`
2. `MessageList` watcher на `activeRoomId` (строки 452-707):
   - `switching = true` → показывает skeleton
   - `loadCachedMessages()` → Dexie query
   - Ожидание `dexieMessagesReady`
   - Polling loop (40 × 50мс = до 2с) для ready-check scroll container
   - `requestAnimationFrame` для scroll to bottom
   - `useReadTracker.startTracking()`
   - `prefetchNextBatch()`
3. Multiple `setTimeout` / `nextTick` / RAF в процессе

**Оценка:** Переключение комнаты — самый тяжёлый сценарий. Множество последовательных async-шагов с промежуточными state-изменениями, каждое из которых может вызвать re-render.

### 3.3. `ChatVirtualScroller.vue` — особенности

**Это НЕ windowed virtualizer** (как vue-virtual-scroller в ContactList). Это:
- Обычный `v-for` с `column-reverse` flex
- **ВСЕ элементы в DOM** (для видимого окна `messageWindowSize`)
- `MutationObserver` следит за добавлением children → корректирует `scrollTop` для anchor preservation
- `MutationObserver` + RAF могут создавать layout thrashing (чтение `offsetHeight` после мутаций)

### 3.4. `MessageBubble.vue`

**Reactive зависимости:**
- `props.message` — основной driver
- `chatStore.getDisplayName` — имя отправителя
- `chatStore.selectionMode`, `selectionStore` — режим выделения
- `useFileDownload().fileState` — прогресс загрузки файла
- `window.resize` listener → `viewportW` ref → layout breakpoints

**`v-memo` guard (строка 1212 MessageList.vue):**
```
v-memo="[item.id, item.message.timestamp, item.message.deleted,
         item.message.reactions, item.message.pollInfo,
         item.message.edited, item.message.status,
         contextMenu.show && contextMenu.message?.id === item.message.id]"
```

**Ограничения v-memo:**
- НЕ включает `message.content`, `message.fileInfo` → если содержимое изменится с тем же timestamp, v-memo пропустит обновление (edge case при дешифровке?)
- НЕ включает `message.uploadProgress` → прогресс загрузки не отслеживается через v-memo
- `contextMenu` проверка — при открытии/закрытии контекстного меню перерисовывается строка с ним (и предыдущая)

### 3.5. `MessageInput.vue`

**Источники перерисовок:**
- `text` ref — каждое нажатие клавиши
- `autoGrow` — RAF для пересчёта высоты textarea
- `saveDraft` — debounce 500мс → Dexie запись (побочный эффект, не прямо UI)
- `setTyping(true)` — throttle 3с → Matrix API call
- `setTyping(false)` — timeout 5с → Matrix API call
- `editingMessage`, `replyingTo`, `forwardingMessage` — watchers с `setTimeout` 400мс

### 3.6. `useReadTracker` — фоновая нагрузка при скролле

- `IntersectionObserver` на каждом message element
- Fallback: **`querySelectorAll` + `getBoundingClientRect`** цикл — **Layout thrashing!**
- Scroll debounce 300мс → `scanViewport` 
- Resize debounce 200мс → `scanViewport` + `flushBatch`
- `setInterval` 2с — `flushBatch` → `chatStore.advanceInboundWatermark`
- `advanceInboundWatermark` коалесцирует с debounce 100мс → Dexie write

---

## 4. Pinia-сторы и каскадная реактивность

### 4.1. `chat-store.ts` — центральный стор

#### Реактивные примитивы

| Символ | Тип | Что вызывает обновление | Кто зависит |
|--------|-----|------------------------|-------------|
| `_sortedRoomsRef` | `shallowRef<ChatRoom[]>` | `patchSortedRooms`, `fullRebuildSortedRoomsAsync` | `sortedRooms` → ContactList × 3 computed + FolderTabs + inviteCount |
| `rooms` | `shallowRef<ChatRoom[]>` | `triggerRef(rooms)` — вручную ~10 мест | Fallback sort watcher, `activeRoom` |
| `messages` | `shallowRef<Record<string, Message[]>>` | `triggerRef(messages)` — вручную ~5 мест | Legacy `activeMessages` fallback |
| `dexieRooms` | `shallowRef<LocalRoom[]>` | `applyDexieDeltas`, `initDexieRooms` | `totalUnread` |
| `_dexieRoomMapVersion` | `ref(0)` | Bump при каждом delta | `activeRoomOutboundWatermark` |
| `dexieMessages` | `shallowRef` (useLiveQuery) | Dexie liveQuery re-fire | `activeMessages` |
| `pinnedRoomIds` | `ref<Set>` | New Set on toggle | Sort watcher (`flush: "sync"`) → full rebuild |
| `mutedRoomIds` | `ref<Set>` | New Set on toggle | UI badges |
| `typing` | `ref<Record<string, ...>>` | `setTypingUsers` | `getTypingUsers` → MessageList, ChatRoomRow |
| `activeRoomId` | `ref<string\|null>` | `setActiveRoom` | liveQuery deps, activeRoom, MessageList watcher |

#### `triggerRef` — места вызова и последствия

`triggerRef(rooms)` вызывается в:
- Загрузка members для комнаты
- Расшифровка preview сообщений
- `optimisticRemoveRoom` / `clearHistory`
- `handleReceiptEvent` (!)

**Проблема:** `triggerRef(rooms)` инвалидирует `activeRoom` computed, даже если `activeRoomId` не менялся. `activeRoom` зависит от `rooms.value` (через `void rooms.value`). Это означает, что **каждый incoming receipt** может вызвать ре-рендер `ChatWindow.vue` header.

`triggerRef(messages)` вызывается в:
- `clearHistory`, `optimisticRemoveRoom`
- Больше не критичен, т.к. Dexie path использует `dexieMessages`

#### Watcher с `flush: "sync"` (строки 1223-1239)

```javascript
watch([rooms, pinnedRoomIds], () => {
  // ...
  if (dexieActive) {
    if (pinsChanged) scheduleFullSortedRebuild();
  } else {
    _sortedRoomsRef.value = computeSortedRoomsFallback(...);
  }
}, { immediate: true, flush: "sync" });
```

**Проблема:** Запускается **синхронно** при каждом `triggerRef(rooms)` или pin toggle. В non-Dexie fallback пути — напрямую пишет `_sortedRoomsRef`, вызывая каскад **в том же тике** (до того как Vue batch'ит обновления).

### 4.2. `userStore` — загрузка профилей

- `users` — `shallowRef<Record<string, User>>`
- `setUser()` → немедленный `triggerRef(users)`
- `setUsers()` batch → debounced `triggerRef(users)` с задержкой 100мс
- Batch profile loader подавляет trigger во время загрузки (`PROFILE_LOADER_BATCH_ACTIVE`)

**Каскад:** `triggerRef(users)` → `ContactList.roomNameMap` → `allFilteredRooms` → `filteredRooms` → RecycleScroller re-render

### 4.3. `channelStore`

- `channels` — `ref<Channel[]>` (deep ref!)
- `posts` — `ref(new Map())` — in-place `Map.set()` может НЕ тригернуть обновление (зависит от Vue version)
- `channels` участвует в `ContactList.allFilteredRooms` (объединённый список для filter="all")

### 4.4. `selectionStore`

- `isSelectionMode`, `_selectedIds` (Set в ref)
- `count` computed, `selectedIds` computed
- Мутации заменяют Set для корректного трекинга

**Проблема:** `isSelectionMode` читается в **каждом** `ChatRoomRow` и `MessageBubble`. Переключение → ре-рендер ВСЕХ видимых строк/сообщений.

---

## 5. Таймеры, наблюдатели, слушатели — полный реестр

### 5.1. Sidebar-компоненты

| Компонент | Тип | Интервал | Что делает | Очистка при unmount |
|-----------|-----|----------|------------|---------------------|
| ContactList | setTimeout | 150мс | Scroll debounce → loadVisibleRooms | **НЕТ** (утечка!) |
| ContactList | setTimeout | 200мс (once) | First-load visible rooms | **НЕТ** |
| ContactList | setTimeout | 350мс | Initial loadVisibleRooms | **НЕТ** |
| ContactList | setTimeout | 2с-64с exp.backoff | Name resolution retry | Да |
| ContactList | RAF | до 20 frames | Wait for clientHeight > 0 | Авто-стоп |
| ContactList | scroll listener | каждый scroll | Debounced viewport load | Да (onUnmounted) |
| ContactsPanel | setTimeout | 100мс | Scroll debounce | Да |
| ContactsPanel | setTimeout | 350мс | Initial load | Да |
| SwipeableTabs | setTimeout | 100мс | Scroll-end detection | Да |
| SwipeableTabs | setTimeout | 400мс | Programmatic scroll flag | Да |
| FolderTabs | - | nextTick | Update indicator position | - |
| BottomTabBar | - | - | Чтение totalUnread | - |
| ConnectionStatusHeader | setTimeout | 30/60с | Stale sync detection | Да |

### 5.2. Chat-компоненты

| Компонент | Тип | Интервал | Что делает | Очистка | Jank-риск |
|-----------|-----|----------|------------|---------|-----------|
| ChatWindow | setInterval | **30с** | Peer key recheck | Да | Низкий |
| MessageList | MutationObserver + RAF | Per mutation | Anchor preservation (scrollTop) | Да | **Средний-Высокий** |
| MessageList | setTimeout | 300мс | Scroll stable flag | Да | Низкий |
| MessageList | setTimeout | **3с** | Force settled safety | **НЕТ** | Средний |
| MessageList | setTimeout poll | 50мс × 40 | Wait for scroll container | Авто-стоп | **Средний** |
| MessageList | RAF throttle | 1/frame | Scroll handler | Да | Низкий |
| MessageList | ResizeObserver + RAF | Per resize | Pin scrollTop near bottom | **RAF не отменяется** | **Средний** |
| MessageList | setTimeout | 1500мс | Hide floating date | Да | Низкий |
| MessageList | setTimeout | 350мс | Entrance animation cleanup | **НЕТ** | Низкий |
| useReadTracker | IntersectionObserver | Per intersection | Track read messages | Да | **Средний** |
| useReadTracker | scroll listener | Per scroll | Fallback scan | Да | **ВЫСОКИЙ** (layout thrashing) |
| useReadTracker | ResizeObserver | Per resize | Scan + flush | Да | Средний |
| useReadTracker | setTimeout | 300мс | Scroll scan debounce | Да | Средний |
| useReadTracker | setTimeout | 200мс | Resize scan debounce | Да | Средний |
| useReadTracker | **setInterval** | **2с** | Batch flush read receipts | Да | Низкий |
| useReadTracker | setTimeout | 500мс | Delayed scan | Да | Средний |
| MessageInput | setTimeout | 500мс | Save draft debounce | **НЕТ** | Низкий |
| MessageInput | setTimeout | **5с** | Stop typing indicator | **НЕТ** | Низкий |
| MessageInput | setTimeout | 400мс | Scroll into view (edit) | **НЕТ** | Низкий |
| MessageInput | RAF | Coalesced | Textarea auto-grow | **RAF не отменяется** | Низкий |
| EmojiPicker | scroll listener | Per scroll | Section detection (getBCR loop) | - | **Средний** |
| VoiceRecorder | **setInterval** | **50мс** | Waveform data update | Да | **ВЫСОКИЙ** |
| ChatSearch | setTimeout | 250мс | Search debounce | **НЕТ** | **Средний** |

### 5.3. Store-level

| Компонент | Тип | Интервал | Что делает | Очистка |
|-----------|-----|----------|------------|---------|
| chat-store | setTimeout | 50мс | Schedule full sorted rebuild | При dispose |
| chat-store | setTimeout | 200мс | Debounce messageWindowSize | По watcher |
| chat-store | setTimeout | 100мс | Coalesce advanceInboundWatermark | По room switch |
| chat-store | setTimeout + setInterval | 30с + 30мин | Room cleanup | При dispose |
| chat-store | setTimeout | 1с × 7 | Preview polling per room | stopPreviewPolling |
| chat-store | document visibility | - | Flush receipts on tab focus | **Никогда** (store lifetime) |
| chat-store | Capacitor appState | - | Sync on foreground | **Не удаляется** |
| Dexie writeBuffer | setTimeout | 150мс | Batch Dexie writes | dispose |
| Dexie roomRepository | queueMicrotask | Per batch | Coalesce room change hooks | unsubscribe |
| decryption-worker | setTimeout | до 60с | Decrypt queue tick | dispose |
| Matrix client | setTimeout | 5с | Synthetic typing stop | destroy |

---

## 6. Известные anti-patterns и проблемные места

### 6.1. КРИТИЧНЫЕ (Вероятные причины видимых тормозов)

#### P1. Полная пересборка `virtualItems` + `reversedItems` на КАЖДОЕ событие

**Файл:** `MessageList.vue:229-312`

Каждый раз когда `activeMessages` меняется (новое сообщение, reaction, read receipt, typing) — два computed итерируют **ВСЕ** сообщения и создают **новые массивы**. При 200 сообщениях в окне — 400+ аллокаций объектов на каждое событие.

`ChatVirtualScroller` получает новый массив → Vue выполняет diff всего `v-for`.

#### P2. `sortedRooms` → каскадная цепочка computed в ContactList

**Файл:** `ContactList.vue:71-398`

При каждом `patchSortedRooms` (входящее сообщение) последовательно пересчитываются:
1. `roomNameMap` — **O(n)** итерация всех комнат + resolve имён
2. `unresolvedRoomSet` — **O(n)** итерация всех комнат
3. `allFilteredRooms` — **O(n)** итерация + фильтрация + map
4. `inviteCount` (в store) — **O(n)** filter

Суммарно: **4× O(n)** на каждое входящее сообщение в любом чате.

#### P3. `triggerRef(rooms)` при incoming receipt

**Файл:** `chat-store.ts` (handleReceiptEvent)

Read receipt → `triggerRef(rooms)` → инвалидирует `activeRoom` → ре-рендер ChatWindow header. А receipts приходят часто (при каждом прочтении сообщения собеседником).

#### P4. `ChatVirtualScroller` — не windowed

**Файл:** `ChatVirtualScroller.vue`

Все сообщения в `messageWindowSize` окне **рендерятся в DOM**. При увеличении окна (scroll up) количество DOM-элементов растёт без ограничений. `MutationObserver` + RAF + layout reads (`offsetHeight`) после каждого DOM изменения — потенциальный layout thrashing.

#### P5. `useReadTracker` fallback scan — layout thrashing

**Файл:** `use-read-tracker.ts`

Когда `IntersectionObserver` работает некорректно, fallback делает `querySelectorAll('[data-message-ts]')` + цикл `getBoundingClientRect()` → **вынужденный reflow** на каждый вызов при скролле (debounce 300мс, но всё равно заметно).

### 6.2. СРЕДНИЕ (Заметны в определённых сценариях)

#### P6. `activeMessages` пересоздаёт ВСЕ own messages при watermark change

**Файл:** `chat-store.ts:838-839`

При `watermarkChanged && isOwnMessage` — все собственные сообщения создаются заново через `localToMessages`, даже если их статус не изменился.

#### P7. Voice recorder — 50мс interval

**Файл:** `use-voice-recorder.ts:91-103`

При записи голосового: `setInterval(50мс)` обновляет `waveformData` ref → **20 Vue re-renders в секунду** для waveform компонента.

#### P8. Все экземпляры `ContactList` смонтированы одновременно

**Файл:** `SwipeableTabs.vue`

Все 4 вкладки (all / personal / groups / invites) + ChannelList смонтированы как siblings в horizontal scroller. Каждый `ContactList` подписан на `sortedRooms`. Изменение `sortedRooms` → пересчёт computed **во всех 4-х экземплярах**, даже невидимых.

#### P9. Утечки таймеров при unmount

Несколько `setTimeout` не очищаются при `onBeforeUnmount`:
- `ContactList` scroll debounce (150мс)
- `MessageList` settled timeout (3с)
- `MessageList` contentResizeRaf
- `MessageInput` draft save, typing stop, edit scroll
- `ChatSearch` search debounce

Сами утечки мелкие, но при быстром переключении между комнатами — late callbacks могут вызывать неожиданные state mutations.

#### P10. Window resize listener на каждом MessageBubble

**Файл:** `MessageBubble.vue:23-24`

Каждый bubble добавляет `window.addEventListener('resize')`. При 200 сообщениях = 200 listeners. При resize → 200 callback'ов обновляют `viewportW` ref → 200 потенциальных ре-рендеров (хотя Vue может batch'ить).

### 6.3. НИЗКИЕ (Фоновые, но стоит знать)

- `EmojiPicker` scroll handler: цикл `getBoundingClientRect` по секциям
- Preview polling: 1с × 7 попыток per room (может суммироваться)
- Room cleanup: 30с initial + 30мин interval (фоновый, но блокирует main thread при больших списках)
- `nextTick` cascades при room switch (множество sequential nextTick)

---

## 7. Рекомендуемые направления оптимизации

> Это не готовый план, а направления для консультанта.

### Быстрые wins (Quick fixes)

1. **Очистка таймеров** — добавить `clearTimeout` в `onBeforeUnmount` для всех утечек из P9
2. **Window resize** — заменить per-bubble listener на один shared (module-level `shallowRef` + один listener)
3. **Voice recorder interval** — увеличить с 50мс до 100-150мс (или RAF-based)
4. **`inviteCount`** — кэшировать отдельно от `sortedRooms`, обновлять инкрементально при `patchSortedRooms`

### Средние оптимизации

5. **`virtualItems` / `reversedItems`** — рассмотреть incremental patching вместо full rebuild. Или использовать `shallowRef` + manual identity check
6. **Lazy mount вкладок** — render ContactList только для активной вкладки (или `v-show` + `deactivated` lifecycle)
7. **`triggerRef(rooms)` granularity** — разделить `activeRoom` computed, чтобы он не зависел от `rooms`, а читал `roomsMap.get(activeRoomId)`
8. **Read receipt path** — не вызывать `triggerRef(rooms)` для receipt events; watermark уже обновляется через Dexie path
9. **`activeMessages` watermark optimization** — при `watermarkChanged` пересоздавать только те own messages, чей status реально изменился

### Архитектурные изменения

10. **Windowed virtualizer для чата** — заменить `ChatVirtualScroller` (v-for column-reverse) на windowed solution (только видимые сообщения в DOM)
11. **Per-room reactivity** — вместо одного `_sortedRoomsRef` array → Map of per-room refs или использование `vue-reactivity-transform`
12. **Computed sharding** — разбить `ContactList.allFilteredRooms` на per-filter computed, чтобы переключение фильтра не пересчитывало весь массив
13. **Offload sorting** — `patchSortedRooms` / `fullRebuildSortedRoomsAsync` в Web Worker для списков > 500 комнат

---

## Приложение A: Диаграмма реактивных зависимостей (Sidebar)

```
Matrix sync event
    │
    ▼
EventWriter.writeMessage()
    │
    ├──► Dexie `messages` table ──► liveQuery (active room only)
    │
    └──► Dexie `rooms` table
              │
              ▼
         Room hooks (creating/updating/deleting)
              │
              ▼
         queueMicrotask batch
              │
              ▼
         observeRoomChanges callback
              │
              ▼
         applyDexieDeltas()
              │
              ├──► dexieRoomMap.set() (non-reactive Map)
              ├──► dexieRooms.value = [...] (shallowRef)
              ├──► _dexieRoomMapVersion++ (ref)
              │
              └──► patchSortedRooms(changes) OR scheduleFullSortedRebuild()
                        │
                        ▼
                   _sortedRoomsRef.value = newArray
                        │
                        ▼
                   sortedRooms (computed)
                        │
          ┌─────────────┼─────────────────────┐
          ▼             ▼                     ▼
    roomNameMap    unresolvedRoomSet     inviteCount
          │             │                     │
          ▼             │                     ▼
    allFilteredRooms ◄──┘              FolderTabs.visibleTabs
          │
          ▼
    filteredRooms (sliced by displayLimit)
          │
          ▼
    RecycleScroller :items
          │
          ▼
    ChatRoomRow × N (visible rows)
```

## Приложение B: Диаграмма реактивных зависимостей (Chat)

```
Matrix sync event / send
    │
    ▼
EventWriter.writeMessage()
    │
    ▼
Dexie `messages` table
    │
    ▼
liveQuery (subscribed to activeRoomId + messageWindowSize)
    │
    ▼
dexieMessages (shallowRef, new array each emission)
    │
    ▼
activeMessages (computed)
    │   - row-level memoization (reuse Message if unchanged)
    │   - BUT: watermarkChanged → all own msgs recreated
    │   - BUT: always new array reference
    │
    ├──► virtualItems (computed) ── iterates ALL messages
    │       │   - adds date separators, unread banner, typing
    │       │   - always new array
    │       │
    │       ▼
    │   reversedItems (computed) ── reverses entire array
    │       │   - always new array
    │       │
    │       ▼
    │   ChatVirtualScroller :items
    │       │
    │       ▼
    │   v-for → MessageBubble × N
    │       │   └── v-memo guards re-render
    │       │
    │       ▼
    │   MutationObserver → RAF → scrollTop adjustment
    │
    └──► MessageList watchers (profile loads, read tracker, etc.)

Parallel path (typing):
    setTypingUsers() → typing ref → typingText computed → virtualItems
    (full array rebuild just to add/remove one typing element)

Parallel path (read receipt):
    writeReceipt() → Dexie rooms → _dexieRoomMapVersion++
    → activeRoomOutboundWatermark → activeMessages
    (all own messages potentially recreated)
```
