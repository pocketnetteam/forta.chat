# Optimistic Media Upload — Design Document

**Дата:** 2026-03-19
**Статус:** Утверждён

## Проблема

При отправке медиа (картинки, файлы, аудио, видео) в чате отсутствует мгновенная обратная связь. Сообщение не появляется в UI до завершения upload + server echo (5–30 сек). Текстовые сообщения работают корректно — появляются мгновенно.

## Root Cause

В `chat-store.ts` computed `activeMessages` при инициализированном Dexie читает **только** из `dexieMessages` (liveQuery). Медиа-отправки (`sendImage`, `sendFile`, `sendAudio`, `sendVideoCircle`, `sendGif`) используют legacy путь `chatStore.addMessage()`, который пишет в `messages.value` — shallowRef, который `activeMessages` полностью игнорирует.

```
// Текст (работает):
sendMessage() → dbKit.messages.createLocal() → Dexie → liveQuery → UI

// Медиа (сломано):
sendImage() → chatStore.addMessage(messages.value) ← ИГНОРИРУЕТСЯ
           → encrypt → upload → send → Matrix echo → EventWriter → Dexie → UI
```

## Решение: Подход A — Inline Async с Dexie-first вставкой

### Принцип

**INSERT FIRST, UPLOAD LATER.** Сообщение появляется в Dexie (и UI через liveQuery) мгновенно с blob URL для превью. Upload идёт асинхронно в той же функции. При ошибке — статус `failed` с кнопкой Retry.

### Почему не SyncEngine-driven

- Хранение blob в IndexedDB удваивает потребление памяти
- Прогресс upload сложно пробросить через SyncEngine → Dexie → UI
- `syncSendFile()` — мёртвый код, требует серьёзной доработки
- При перезапуске mid-upload файл остаётся в галерее — пользователь просто отправит заново (паттерн WhatsApp/Telegram)

## State Machine

```
pending → uploading → syncing → synced
              ↓
           failed ←→ uploading (retry)
```

| Статус | Описание |
|--------|----------|
| `pending` | Создано локально, blob URL в fileInfo, ещё не начали upload |
| `uploading` | Upload в процессе, `uploadProgress` обновляется 0–100 |
| `syncing` | Файл загружен, Matrix event отправляется |
| `synced` | Сервер подтвердил, eventId получен |
| `failed` | Upload или отправка упали, кнопка Retry в UI |

## Расширение схемы данных

### LocalMessage — новые поля

```typescript
uploadProgress?: number;   // 0-100, только во время uploading
localBlobUrl?: string;     // blob: URL для мгновенного превью
```

Миграция Dexie v7 — добавление полей (nullable, без изменения индексов).

### Message interface — новое поле

```typescript
uploadProgress?: number;   // пробрасывается из LocalMessage через mapper
```

## Локальные URL

### Создание
```typescript
const localBlobUrl = URL.createObjectURL(file);
```

### Хранение
- `localBlobUrl` — отдельное поле в LocalMessage (не отправляется на сервер)
- `fileInfo.url` — изначально blob URL, после upload заменяется на mxc://

### Маппинг в UI
`localToMessage()` приоритизирует: `local.localBlobUrl || local.fileInfo.url`

### Очистка
`URL.revokeObjectURL()` вызывается через 5 сек после `confirmSent()` — даёт время `useFileDownload` закешировать серверную версию.

### Capacitor/Native
Вместо blob URL — `Capacitor.convertFileSrc(filePath)`.

## UI-индикация

| Статус | Изображение | Файл/Аудио | StatusIcon |
|--------|-------------|-------------|------------|
| `pending` | Превью + спиннер | Имя + "Подготовка..." | Clock |
| `uploading` | Превью + circular progress (%) | Progress bar + % | Clock |
| `failed` | Превью + иконка retry | Имя + "Повторить" | Red ! |
| `syncing` | Превью + спиннер | Имя + спиннер | Clock |
| `synced` | Чистое изображение | Имя + размер | ✓ |

### Circular Progress (изображения)
SVG circle с `stroke-dashoffset` поверх тёмного overlay `bg-black/30`. Процент текстом по центру.

### Retry
Кнопка поверх медиа при `status === failed`. Tap → перезапуск upload с шага 3 pipeline.

## Pipeline — handleMediaSubmit(file, chatId)

1. **Генерация локальных данных** — `clientId = UUID`, `localBlobUrl = URL.createObjectURL(file)`, dimensions для изображений
2. **Мгновенная вставка в Dexie** — `createLocal()` с `status: 'pending'`, `fileInfo.url = localBlobUrl`, обновление room preview
3. **Upload с прогрессом** — `status → 'uploading'`, `uploadContentWithProgress()` с callback обновляющим `uploadProgress` в Dexie
4. **Отправка Matrix event** — `status → 'syncing'`, шифрование, `sendEncryptedText()` с clientId как transaction ID
5. **Подтверждение** — `confirmSent()`: замена blob URL на mxc://, `status → 'synced'`, очистка `uploadProgress`/`localBlobUrl`
6. **Очистка** — `setTimeout(() => URL.revokeObjectURL(), 5000)`

При ошибке на любом шаге 3-4: `status → 'failed'`, blob URL сохраняется для отображения.

## Upload с прогрессом

Новый метод `uploadContentWithProgress(blob, onProgress)` в Matrix service. Использует `XMLHttpRequest` с `xhr.upload.onprogress` для получения `loaded/total`.

## Затрагиваемые файлы

| Файл | Изменение |
|------|-----------|
| `src/shared/lib/local-db/schema.ts` | Миграция v7: `uploadProgress`, `localBlobUrl` |
| `src/shared/lib/local-db/message-repository.ts` | `createLocal()` для медиа, `updateUploadProgress()` |
| `src/shared/lib/local-db/mappers.ts` | `localToMessage()` — проброс blob URL и progress |
| `src/entities/chat/model/types.ts` | `uploadProgress` в Message interface |
| `src/features/messaging/model/use-messages.ts` | Все send-функции → Dexie-first путь |
| `src/features/messaging/ui/MessageBubble.vue` | Circular progress, retry кнопка |
| `src/entities/matrix/model/matrix-client.ts` | `uploadContentWithProgress()` |
| `src/features/messaging/model/use-file-download.ts` | Учёт localBlobUrl как источника (уже работает) |

## Не входит в скоуп

- Автоматический retry после перезапуска приложения (YAGNI)
- Хранение blob в LocalAttachment таблице
- Thumbnail generation для видео
- Сжатие изображений перед upload
