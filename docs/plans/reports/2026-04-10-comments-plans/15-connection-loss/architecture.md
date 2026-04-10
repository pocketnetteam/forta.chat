# Архитектура: Потеря соединения

## Связь с проблемой

Пользователи сообщают: «во время переписки пропадает соединение», «нужно перезапускать приложение».

## Механизмы восстановления соединения

### 1. Matrix SDK (встроенный)

`matrix-js-sdk-bastyon` имеет встроенный механизм:
- Long-poll `/sync` с `pollTimeout: 60000` (60s)
- При ошибке: exponential backoff
- `retryImmediately()` — обход backoff

### 2. Обработка в MatrixClientService

`src/entities/matrix/model/matrix-client.ts`:

```typescript
client.on("sync", (state) => {
  if (state === "PREPARED" || state === "SYNCING") {
    chatsReady = true;
  } else if (state === "ERROR") {
    console.warn("[matrix] Sync error — requesting immediate retry");
    client.retryImmediately();
  } else if (state === "STOPPED") {
    console.warn("[matrix] Sync stopped unexpectedly");
  }
  onSync?.(state);
});
```

### 3. Auth Store обработчик

`src/entities/auth/model/stores.ts`:

```typescript
onSync: (state) => {
  const wasDisconnected = _lastSyncState === "ERROR" || _lastSyncState === "RECONNECTING";
  _lastSyncState = state;
  
  if (state === "PREPARED" || state === "SYNCING") {
    chatStore.refreshRooms(state);
    if (wasDisconnected && state === "SYNCING") {
      console.log("[auth] Sync recovered from disconnect — forcing full refresh");
      chatStore.refreshRooms("PREPARED");  // принудительное полное обновление
    }
  } else if (state === "ERROR" || state === "RECONNECTING") {
    chatStore.setSyncState(state);
  }
}
```

### 4. Capacitor: возврат из фона

`src/entities/chat/model/chat-store.ts`:

```typescript
App.addListener("appStateChange", ({ isActive }) => {
  if (isActive) {
    // WebView suspension aborts pending /sync long-poll,
    // leaving SDK in backoff. retryImmediately() bypasses delay.
    matrixService.client?.retryImmediately();
    // + обновление комнат и unread
  }
});
```

### 5. Push deep link

`src/app/App.vue`: при открытии чата из push уведомления → `retryImmediately()`.

## Offline-First: SyncEngine

### Очередь исходящих

`src/shared/lib/local-db/sync-engine.ts`:

```
processQueue():
  if (!online) return  // пауза при offline
  
  operation = pendingOps.where("status").equals("pending").first()
  try:
    executeOperation(op)
    delete op
  catch:
    retries++
    if retries >= maxRetries (5):
      markMessageFailed(op)
    else:
      backoff + jitter → retry
```

### Browser events

```typescript
// stores.ts
window.addEventListener("online", () => syncEngine.setOnline(true));
window.addEventListener("offline", () => syncEngine.setOnline(false));
```

### Восстановление при запуске

```
initChatDb() → recoverStrandedOps() → processQueue()
// Сброс "syncing" → "pending" для операций, застрявших при crash
```

## Lifecycle приложения

### Веб

```
Браузер:
  online event → syncEngine.setOnline(true), SDK retries
  offline event → syncEngine.setOnline(false)
  visibilitychange → нет специальной обработки
```

### Android (Capacitor)

```
Foreground → Background:
  - WebView suspends → /sync long-poll aborts
  - SDK enters backoff
  
Background → Foreground:
  - appStateChange(isActive: true)
  - retryImmediately() → обход backoff
  - refreshRooms + processQueue
  
App Killed → Cold Start:
  - Полная инициализация заново
  - recoverStrandedOps для SyncEngine
  
Push while background:
  - FCM → нативное уведомление (без JS)
  - При тапе → MainActivity → processPushOpenRoom
```

### Electron

```
Аналогично вебу + Tor transport
Нет специфичных обработчиков suspend/resume в electron/main.cjs
```

## Проблема «нужно перезапускать»

### Возможные причины

1. **SDK backoff слишком длинный** — после длительного offline SDK может ждать минуты перед retry
   - Решение: `retryImmediately()` вызывается при возврате из фона, но не при восстановлении сети на вебе

2. **WebView suspension** — на Android WebView может быть убит системой
   - JS-код не работает → нет обработки `online` event
   - FCM push доставляется нативно, но JS не обновляет состояние

3. **IndexedDB lock** — при нескольких вкладках может быть конфликт блокировок
   - Dexie `versionchange` → закрытие БД → потеря состояния

4. **Matrix access token expired** — после длительного offline
   - SDK не обрабатывает 401 gracefully в обычном sync
   - Background sync: при 401/403 → stop (корректно)

5. **Memory pressure** — на мобиле WebView может потерять состояние
   - `MutationObserver`, `IntersectionObserver`, `ResizeObserver` перестают работать

## UI индикация состояния

### Sync state в UI

`chatStore.setSyncState(state)`:
- Передаётся через `syncState` reactive
- Может использоваться для показа индикатора "Reconnecting..."
- Конкретный UI banner для reconnect — определяется в `ChatWindow.vue` / `ChatPage.vue`

### Boot состояние

`bootStatus`:
- `currentStep` — текущий шаг загрузки
- `setError(message)` — ошибка с текстом
- `AppLoading` компонент показывает эти состояния

## Background Sync (мультиаккаунт)

`BackgroundSyncManager`:

```typescript
private async poll(poller: Poller): Promise<void> {
  const url = `${poller.homeserverUrl}/_matrix/client/v3/sync?timeout=0&since=${poller.syncToken}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${poller.accessToken}` }
  });
  
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      this.stop(poller.address);  // токен невалиден
      return;
    }
    // retry later
  }
}
```

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `src/entities/matrix/model/matrix-client.ts` | Sync handler, retryImmediately |
| `src/entities/auth/model/stores.ts` | onSync, online/offline events |
| `src/entities/auth/model/background-sync.ts` | Background polling |
| `src/shared/lib/local-db/sync-engine.ts` | Offline queue, retry logic |
| `src/shared/lib/local-db/index.ts` | recoverStrandedOps at init |
| `src/entities/chat/model/chat-store.ts` | appStateChange, syncState |
| `src/app/App.vue` | Push resume, retryImmediately |
| `src/app/index.ts` | Boot timeout (60s) |
