# Архитектура: Отправка сообщений

## Связь с проблемой

Пользователи сообщают: «сообщение серое и не отправляется», «не отправляются ни с ПК, ни с телефона», ошибка «получатель не предоставил ключи шифрования», «помогает перезапуск».

## Путь сообщения: UI → Matrix API

### 1. Ввод и отправка

`MessageInput.vue` → `useMessages().sendMessage()` (`src/features/messaging/model/use-messages.ts`)

### 2. Оптимистичная запись в Dexie

```
MessageRepository.createLocal({
  roomId, senderId, content, type: MessageType.text
})
→ статус "pending" + обновление превью комнаты
```

### 3. Проверка Matrix

Если `matrixService.isReady() === false`:
- `markFailed(localClientId)` → сообщение сразу failed (серое)
- **Это основная причина «серых сообщений»**

### 4. Очередь SyncEngine

```
dbKit.syncEngine.enqueue("send_message", roomId, { content }, localMsg.clientId)
→ таблица pendingOps в IndexedDB
```

### 5. Обработка в SyncEngine

`SyncEngine.syncSendMessage()` (`src/shared/lib/local-db/sync-engine.ts`):

```
1. Получение PcryptoRoomInstance через getRoomCrypto
2. Если canBeEncrypt():
   → roomCrypto.encryptEvent(content) → зашифрованный payload
3. Иначе:
   → plaintext { msgtype: "m.text", body: content }
4. matrixService.sendEncryptedText(roomId, content, clientId)
5. messageRepo.confirmSent(clientId, serverEventId) → статус "synced"
```

### 6. Matrix API

`MatrixClientService.sendEncryptedText()` (`src/entities/matrix/model/matrix-client.ts`):
```
client.sendEvent(roomId, "m.room.message", content, txnId)
// txnId = clientId для дедупликации
```

## Шифрование: Pcrypto (НЕ Olm/Megolm)

**Важно:** Forta Chat **НЕ использует** стандартный Matrix E2EE (Olm/Megolm). Вместо этого — кастомный **Pcrypto** (порт из bastyon-chat).

### Алгоритмы

| Тип | Алгоритм |
|-----|----------|
| 1:1 текст | ECDH (secp256k1) + AES-SIV (miscreant) |
| Группа текст | Общий ключ + AES-CBC + PBKDF2 |
| Файлы | AES-CBC + PBKDF2 |
| Кривая | secp256k1 |

### 1:1 чаты (tetatet)

`encryptEvent()` в `src/entities/matrix/model/matrix-crypto.ts`:

```
Для каждого участника (кроме себя):
  → _encrypt(userId, text) → ECDH shared secret → AES-SIV
  
Результат:
{
  block: currentblock.height,
  version: version,
  msgtype: "m.encrypted",
  body: Base64(JSON({ [userId]: { encrypted, nonce } }))
}
```

### Группы

`encryptEventGroup()`:

```
1. getOrCreateCommonKey() — общий секрет группы
2. Если нет ключа: sendCommonKey()
   → State event "m.room.encryption" с ключом, зашифрованным для каждого участника
3. pcryptoFile.encrypt(text, commonKey) → { hash, body: hex }
```

### Условие шифрования: `canBeEncrypt()`

Все условия должны быть true:
- Чат НЕ публичный
- У текущего пользователя **ровно 12 приватных ключей**
- Есть список участников (users)
- **1 < участников < 50**
- У **ВСЕХ** участников в `usersinfo` есть **≥ 12** публичных ключей

## Ошибка «Получатель не предоставил ключи шифрования»

### Блокировка отправки (UI)

`chatStore.checkPeerKeys()` в `src/entities/chat/model/chat-store.ts`:

```
Если !isRoomPublic && !canBeEncrypt() && memberCount < 50:
  → peerKeysStatus = "missing"
  → MessageInput: peerKeysOk = false → кнопка отправки disabled
  → ChatWindow: баннер "chat.peerKeysMissing"
```

### Причины отсутствия ключей

1. Собеседник зарегистрировался, но **не опубликовал 12 ключей** в блокчейн
2. `verifyAndRepublishKeys()` не завершился (нет PKOIN)
3. Legacy аккаунт Bastyon без ключей нового формата
4. Сетевая проблема: `loadUsersInfoRaw` не загрузил профиль собеседника

### При расшифровке

- `decryptEvent`: *«no encrypted payload for this user — sender may not have our encryption keys»*
- Тело сообщения становится `"[encrypted]"` → Dexie хранит `encryptedRaw`
- `DecryptionWorker` пытается повторную расшифровку с backoff

## Offline-отправка (SyncEngine)

### Очередь

- Таблица `pendingOps` в IndexedDB: `++id` (глобальный FIFO)
- `.where("status").equals("pending").first()` — самая старая операция

### Retry

```
try:
  executeOperation(op)
  pendingOps.delete(op.id)
catch:
  retries++
  if retries >= maxRetries (5):
    markMessageFailed(op) → статус "failed"
  else:
    backoff = min(1000 * 2^retries, MAX_BACKOFF)
    delay = backoff + random(0, backoff * 0.5)
    sleep(delay)
```

### Online/Offline

```
window "online"  → syncEngine.setOnline(true)  → processQueue()
window "offline" → syncEngine.setOnline(false) → пауза
```

### Восстановление при старте

`initChatDb()` → `recoverStrandedOps()` (сброс `syncing` → `pending`) → `processQueue()`

## Статусы сообщений в UI

### Маппинг (`src/shared/lib/local-db/mappers.ts`)

| LocalMessageStatus | MessageStatus | UI |
|--------------------|---------------|----|
| `pending` | `sending` | Часы |
| `syncing` | `sending` | Часы |
| `synced` | `sent` | Галочка |
| `failed` | `failed` | Красная полоска |

### UI failed

`MessageBubble.vue`: красная полоска «Tap to retry»
→ `retryMessage` → сброс в `pending` → `syncEngine.enqueue`

## Получение сообщений

### Matrix Sync → Timeline

```
matrix-client.ts: Room.timeline event
  → фильтр (не pagination, не to_start)
  → onTimeline callback

stores.ts: onTimeline
  → chatStore.markRoomChanged(roomId)
  → chatStore.handleTimelineEvent(event, roomId)
```

### Обработка в chat-store

`handleTimelineEvent()`:
- Реакции, state → system messages
- Звонки (`m.call.hangup`)
- `m.room.message` → расшифровка `m.encrypted` → `addMessage` + `dexieWriteMessage`
- Правки `m.replace`, донаты, медиа, реплаи, forward

### Повтор расшифровки

`DecryptionWorker` (`src/shared/lib/local-db/decryption-worker.ts`):
- Backoff при неудаче
- `retryForRoom` при `onKeysLoaded`
- `retryAllWaiting` при переходе online

## Дедупликация

`MessageRepository.upsertFromServer()`:
- Матчит echo по `clientId`
- Обновляет `eventId` и статус на `synced`
- Предотвращает дубли при sync

## Типы сообщений

```typescript
enum MessageType {
  text, image, file, video, audio,
  system, poll, transfer, videoCircle
}
```

Matrix msgtype: `m.text`, `m.image`, `m.file`, `m.audio`, `m.video`, `m.encrypted` (Pcrypto), `m.notice` (transfer), `org.matrix.msc3381.*` (polls)

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `src/features/messaging/model/use-messages.ts` | UI логика отправки/retry |
| `src/features/messaging/ui/MessageInput.vue` | Поле ввода, проверка peerKeysOk |
| `src/shared/lib/local-db/sync-engine.ts` | Очередь, backoff, offline |
| `src/shared/lib/local-db/message-repository.ts` | CRUD Dexie, дедупликация |
| `src/shared/lib/local-db/event-writer.ts` | Запись входящих в Dexie |
| `src/shared/lib/local-db/mappers.ts` | Маппинг статусов |
| `src/shared/lib/local-db/decryption-worker.ts` | Повтор расшифровки |
| `src/entities/matrix/model/matrix-client.ts` | sendEvent, timeline handler |
| `src/entities/matrix/model/matrix-crypto.ts` | Pcrypto: encrypt/decrypt |
| `src/entities/chat/model/chat-store.ts` | handleTimelineEvent, checkPeerKeys |
| `src/features/messaging/ui/MessageBubble.vue` | UI статусов, retry |
| `src/features/messaging/ui/MessageStatusIcon.vue` | Иконка статуса |
