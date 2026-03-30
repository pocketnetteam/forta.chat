# Архитектура хранения данных и реактивности

## Обзор

Forta Chat использует **offline-first** архитектуру с двухуровневым хранением:

1. **Dexie (IndexedDB)** — единый источник истины для персистентных данных
2. **Pinia stores** — реактивный слой для Vue-компонентов (in-memory кэш)

Данные текут в одном направлении: **Matrix SDK → EventWriter → Dexie → liveQuery → Pinia → Vue UI**.

---

## 1. Слои хранения

### 1.1 Dexie (IndexedDB) — 8 таблиц

| Таблица | Назначение | Ключ | Индексы |
|---------|-----------|------|---------|
| `rooms` | Метаданные комнат | `id` | `updatedAt` |
| `messages` | Все сообщения | `id` | `[roomId+timestamp]`, `roomId` |
| `users` | Профили пользователей | `address` | — |
| `pendingOps` | Очередь отправки (offline) | `++id` | `roomId`, `status` |
| `syncState` | Точка синхронизации Matrix | `key` | — |
| `attachments` | Метаданные вложений | `id` | `messageId` |
| `decryptionQueue` | Очередь повторной расшифровки | `id` | `roomId`, `retryAfter` |
| `listenedMessages` | Прослушанные голосовые | `id` | — |

### 1.2 Pinia stores — 3 основных

| Store | Данные | Тип реактивности |
|-------|--------|-------------------|
| `chatStore` | rooms, sortedRooms, activeRoom, messages | `shallowRef` + `triggerRef` |
| `userStore` | users (профили), displayNames | `shallowRef` + `debouncedTrigger` |
| `authStore` | credentials, matrixClient, initState | `ref` |

### 1.3 localStorage — 4 ключа

| Ключ | Назначение | Причина |
|------|-----------|---------|
| `users` | Кэш профилей | Мгновенный старт без ожидания IndexedDB |
| `pinnedRooms` | Закреплённые комнаты | Быстрый доступ без async |
| `mutedRooms` | Заглушённые комнаты | Быстрый доступ без async |
| `registration` | Данные регистрации | Авторизация до инициализации stores |

### 1.4 In-memory кэши

| Кэш | Назначение | Инвалидация |
|-----|-----------|-------------|
| `decryptedPreviewCache` | Расшифрованные превью | При новом lastMessage |
| `userDisplayNames` | Маппинг address → name | При обновлении профиля |
| `_chatRoomFromDexieCache` | Конвертированные комнаты | При изменении в Dexie |
| `roomFetchStates` | Статус загрузки комнат | При завершении fetch |
| `ProfileLoader.pending` | In-flight запросы профилей | При получении ответа |

---

## 2. Потоки данных

### 2.1 Matrix Sync → UI

```
Matrix /sync response
  ↓
matrix-js-sdk парсит события
  ↓
EventWriter.processEvents()          ← транзакционная запись
  ├─ Dexie.rooms.bulkPut()          ← обновление метаданных
  ├─ Dexie.messages.bulkPut()       ← новые сообщения
  └─ Dexie.syncState.put()          ← сохранение since-токена
  ↓
liveQuery подписки срабатывают       ← Dexie observable API
  ↓
chatStore.rooms.value мутируется
  ↓
triggerRef(rooms)                    ← явный триггер Vue reactivity
  ↓
computeSortedRooms() / patchSortedRooms()
  ↓
sortedRooms обновляется
  ↓
ContactList.vue перерисовывает список
```

**Оптимизация для 100k+ комнат:**
- `patchSortedRooms()` — O(k) инкрементальная сортировка (только изменённые комнаты)
- `_suppressDexieRecompute` — подавляет каскадные пересортировки во время bulk-записи
- `_deferredChanges` — накапливает изменения, применяет одним batch

### 2.2 Отправка сообщения

```
Пользователь нажимает "Отправить"
  ↓
SyncEngine.enqueue(pendingOp)
  ├─ Dexie.pendingOps.add()         ← persisted offline
  └─ Dexie.messages.add()           ← оптимистичная вставка (status: "sending")
  ↓
UI мгновенно показывает сообщение    ← через liveQuery
  ↓
SyncEngine обрабатывает очередь (FIFO)
  ├─ matrixClient.sendEvent()
  ├─ Успех → Dexie.messages.update(status: "sent")
  └─ Ошибка → retry с exponential backoff + jitter
```

### 2.3 Push-уведомление → Открытие чата

```
FCM/APNs доставляет push
  ↓
PushDataPlugin (native) буферизует intent
  ↓
push-service.ts декодирует payload
  ├─ Фаза 1: Проверяет timeline (сообщение уже в Dexie?)
  ├─ Фаза 2: fetchRoomEvent() — целевой запрос одного события
  └─ Фаза 3: Ожидание sync до 15 секунд
  ↓
Показывает системное уведомление
  ↓
Тап по уведомлению:
  ├─ window.dispatchEvent('push:openRoom')
  ├─ matrixClient.retryImmediately()   ← форсированный sync
  └─ chatStore.setActiveRoom(roomId)
  ↓
ChatPage.vue загружает сообщения комнаты
```

### 2.4 Открытие комнаты

```
setActiveRoom(roomId)
  ↓
roomFetchStates.set(roomId, "loading")
  ↓
Dexie.messages.where({roomId}).sortBy('timestamp')
  ↓
Если сообщений < THRESHOLD:
  ├─ matrixClient.scrollback()       ← подгрузка истории
  └─ EventWriter записывает в Dexie
  ↓
liveQuery обновляет messages
  ↓
roomFetchStates.set(roomId, "ready")
  ↓
ChatVirtualScroller рендерит сообщения
```

### 2.5 Загрузка профилей

```
Viewport скроллится → loadVisibleRooms()
  ↓
Собирает адреса из видимых комнат:
  ├─ room.members (для аватаров)
  ├─ systemMeta.senderAddr / targetAddr
  └─ Фильтрует: только отсутствующие в userStore
  ↓
userStore.enqueueProfiles(addresses)
  ↓
ProfileLoader (DataLoader-паттерн):
  ├─ Батч до 30 адресов
  ├─ requestIdleCallback для планирования
  ├─ PromisePool для дедупликации in-flight
  └─ PROFILE_LOADER_BATCH_ACTIVE sentinel
      подавляет промежуточные triggerRef
  ↓
API Bastyon → профили
  ↓
userStore.users обновляется
  ↓
debouncedTrigger (50ms) → UI обновляется
```

### 2.6 Read Receipts

```
Сообщение появляется в viewport
  ↓
IntersectionObserver фиксирует видимость
  ↓
chatStore.markAsRead(roomId, eventId)
  ├─ Обновляет watermark в Dexie
  └─ Буферизует для отправки (debounce 2s)
  ↓
flushPendingReadWatermarks()
  ↓
matrixClient.sendReadReceipt()
```

---

## 3. Реактивные паттерны

### 3.1 shallowRef + triggerRef

```typescript
const rooms = shallowRef<ChatRoom[]>([]);

// Мутация без создания нового массива (экономия GC):
rooms.value[idx] = updatedRoom;
triggerRef(rooms);  // явно уведомляем Vue
```

**Почему:** `ref()` на массиве 100k+ элементов создаёт deep proxy — каждая мутация O(n). `shallowRef` отслеживает только ссылку, `triggerRef` — ручной контроль.

### 3.2 liveQuery (Dexie → Pinia)

```typescript
// В chatStore:
const subscription = liveQuery(() =>
  db.rooms.orderBy('updatedAt').reverse().toArray()
).subscribe(dexieRooms => {
  rooms.value = dexieRooms.map(toChatRoom);
  triggerRef(rooms);
});
```

Dexie автоматически отслеживает, какие таблицы/индексы читаются в callback, и пере-вызывает его при изменениях.

### 3.3 Каскадная защита (batch writes)

```typescript
// Во время bulk-записи EventWriter:
chatStore._suppressDexieRecompute = true;

await db.transaction('rw', db.rooms, db.messages, async () => {
  await db.rooms.bulkPut(roomUpdates);
  await db.messages.bulkPut(newMessages);
});

chatStore._suppressDexieRecompute = false;
chatStore._applyDeferredChanges();  // одна пересортировка вместо N
```

### 3.4 Сортировка комнат

```typescript
// Полная пересортировка (только при инициализации):
function computeSortedRooms(): ChatRoom[] {
  return [...rooms.value].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
}

// Инкрементальная (при каждом sync):
function patchSortedRooms(changedIds: Set<string>) {
  // O(k log n): удалить изменённые, вставить binary search
  for (const id of changedIds) {
    removeFromSorted(id);
    insertSorted(roomsById.get(id));
  }
}
```

### 3.5 ProfileLoader sentinel

```typescript
// Подавление промежуточных ре-рендеров:
userStore._batchActive = PROFILE_LOADER_BATCH_ACTIVE;

for (const batch of chunks(addresses, 30)) {
  const profiles = await fetchBatch(batch);
  Object.assign(userStore.users.value, profiles);
  // НЕ вызываем triggerRef здесь
}

userStore._batchActive = null;
triggerRef(userStore.users);  // один ре-рендер в конце
```

---

## 4. Жизненный цикл приложения

### 4.1 Startup (холодный старт)

```
1. localStorage → userStore (мгновенные профили)
2. Dexie open → syncState.get('since')
3. matrixClient.startClient({ initialSyncLimit: 1 })
4. Первый /sync ← сервер отправляет state для всех joined rooms
5. EventWriter → Dexie → liveQuery → rooms заполняются
6. roomsInitialized = true → скелетоны исчезают
7. ProfileLoader грузит имена видимых комнат
8. namesReady = true → имена появляются
```

### 4.2 Background → Foreground (Android)

```
App.addListener("appStateChange", ({ isActive }) => {
  if (isActive) {
    matrixClient.retryImmediately();  // bypass backoff
    chatStore.refreshRooms();          // инкрементальный refresh
    flushPendingReadWatermarks();      // отправить накопленные receipts
  }
});
```

### 4.3 Logout / Cleanup

```
authStore.logout()
  ├─ matrixClient.stopClient()
  ├─ matrixClient.clearStores()
  ├─ Dexie.delete()              ← удаление всей базы
  ├─ localStorage.clear()
  └─ Pinia stores.$reset()
```

---

## 5. Серверные оптимизации

### Matrix Sync Filter

```typescript
const filter = {
  room: {
    timeline: { limit: 1 },          // только последнее сообщение
    state: { lazy_load_members: true }, // члены по запросу
    ephemeral: { types: [] },          // без typing indicators
  },
  presence: { types: [] },             // без статусов онлайн
};
```

Это критично для 100k+ комнат — без фильтра каждый sync тащит полную timeline + все state events.

### Incremental Room Refresh

```typescript
// Вместо O(n) пересканирования всех комнат SDK:
async function incrementalRoomRefresh(changedRoomIds: string[]) {
  for (const id of changedRoomIds) {
    const sdkRoom = matrixClient.getRoom(id);
    if (sdkRoom) updateSingleRoom(sdkRoom);
  }
  patchSortedRooms(new Set(changedRoomIds));
}
```
