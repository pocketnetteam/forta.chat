# Архитектура: Загрузка, доступ и сеть

## Связь с проблемой

Пользователи сообщают: «не грузится», зависает на 2/3 загрузки, работает только с VPN, «иногда работает, иногда нет».

## Последовательность загрузки приложения

### Boot Pipeline (`src/app/index.ts` → `src/app/providers/index.ts`)

```
1. [scripts]  — загрузка Bastyon SDK скриптов (30s таймаут)
2. [tor]      — (только натив) фоновая инициализация Tor
3. [auth]     — инициализация роутера, проверка сессии
4. [matrix]   — подключение к Matrix homeserver (45s таймаут)
5. [sync]     — первичная синхронизация Matrix (/sync)
6. [ready]    — приложение готово
```

Глобальный boot timeout: **60 секунд** — если не выходит из `booting`, показывается ошибка.

### UI загрузки

`AppLoading` компонент: показывает текст текущего шага через `bootStatus.currentStep`, включая сообщения ошибок через `bootStatus.setError()`.

## Сетевые подключения

### Matrix Homeserver

```
URL: https://matrix.pocketnet.app
Константа: MATRIX_SERVER в src/shared/config/constants.ts
```

- Единственный хардкоженный сервер, выбор серверов **не реализован**
- HTTP-транспорт: `axios` с таймаутом 30s внутри `MatrixClientService.request()`
- Sync: long-poll `pollTimeout: 60000` (60s)
- Filter: `initialSyncLimit: 1`, `lazyLoadMembers: true`, `disablePresence: true`

### Bastyon/Pocketnet RPC

```
Ноды: 1.pocketnet.app:8899, 2.pocketnet.app:8899, 6.pocketnet.app:8899
WebSocket: wss://{host}:8099
Конфиг: PROXY_NODES в src/shared/config/constants.ts
```

### WebRTC сигнализация

```
WebSocket: wss://pocketnet.app:9090
HTTP: https://pocketnet.app:9091
```

### Tor (натив / Electron)

- Android: `tor-service.ts` → запуск фонового Tor-демона
- Electron: Service Worker-мост к Tor в main process
- Опциональный прокси Matrix через `127.0.0.1:8181`
- В `SettingsPage.vue`: переключатель Tor (только натив/Electron)

## Обработка потери соединения

### Matrix SDK уровень

В `matrix-client.ts`:

```
sync "ERROR"     → console.warn + retryImmediately()
sync "STOPPED"   → console.warn
sync "PREPARED"  → chatsReady = true
sync "SYNCING"   → chatsReady = true
```

### Auth Store уровень (`stores.ts`)

```
onSync("ERROR" | "RECONNECTING"):
  → chatStore.setSyncState(state)
  → _lastSyncState = state

onSync("SYNCING") после wasDisconnected:
  → console.log("Sync recovered from disconnect")
  → chatStore.refreshRooms("PREPARED")  // принудительное обновление
```

### Capacitor: возврат из фона (`chat-store.ts`)

```
App.addListener("appStateChange", ({ isActive }) => {
  if (isActive) {
    matrixService.client.retryImmediately()  // обход backoff SDK
    // + обновление комнат и unread
  }
})
```

### Push deep link (`App.vue`)

При открытии чата из пуша также вызывается `retryImmediately()`.

## Offline-First: SyncEngine

`src/shared/lib/local-db/sync-engine.ts`:

- **FIFO очередь** в IndexedDB (таблица `pendingOps`)
- **Exponential backoff + jitter**: `base = min(1000 * 2^retries, MAX_BACKOFF)`, `delay = base + random(0, base * 0.5)`
- `maxRetries = 5` по умолчанию
- `setOnline(false)` → пауза обработки; `setOnline(true)` → `processQueue()`
- При старте: `recoverStrandedOps()` (сброс `syncing` → `pending`)

Привязка к browser events в `stores.ts`:

```
window.addEventListener("online", () => syncEngine.setOnline(true))
window.addEventListener("offline", () => syncEngine.setOnline(false))
```

## Доступность серверов

Явного health-check / ping **нет**. Определение доступности:

1. Успех/провал `matrixService.init()` (таймаут 45s)
2. HTTP ошибки в `request()` (axios)
3. Состояние sync SDK (`ERROR`, `RECONNECTING`)
4. Фоновый polling неактивных аккаунтов: `fetch(/_matrix/client/v3/sync?timeout=0)` → `res.ok`, `401`/`403` → stop

## Конфигурация

### Vite (`vite.config.ts`)

- `server.host: '0.0.0.0'`, `allowedHosts: true` — для dev-доступа по сети
- Нет `server.proxy` к API
- Полифиллы для `buffer`, `stream-browserify`, crypto-модулей

### Capacitor (`capacitor.config.ts`)

```typescript
server: {
  androidScheme: 'https'
}
```

- Нет `allowNavigation`, `ios.contentInset`
- Нет `network_security_config.xml` в Android

## Домены и порты (полный список)

| Домен | Порт | Протокол | Назначение |
|-------|------|----------|------------|
| `matrix.pocketnet.app` | 443 | HTTPS | Matrix homeserver + push gateway |
| `1.pocketnet.app` | 8899 | HTTPS | RPC proxy |
| `2.pocketnet.app` | 8899 | HTTPS | RPC proxy |
| `6.pocketnet.app` | 8899 | HTTPS | RPC proxy |
| `*.pocketnet.app` | 8099 | WSS | WebSocket |
| `pocketnet.app` | 9090 | WSS | WebRTC signaling |
| `pocketnet.app` | 9091 | HTTPS | WebRTC HTTP |
| `pocketnet.app` | 8092 | HTTPS | Upload (avatar etc.) |
| `forta.chat` | 443 | HTTPS | Public URL (ссылки, invite) |

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `src/app/index.ts` | Entry point, boot timeout |
| `src/app/providers/index.ts` | Boot pipeline: scripts → tor → auth → matrix |
| `src/entities/matrix/model/matrix-client.ts` | HTTP-транспорт, sync, reconnect |
| `src/entities/auth/model/stores.ts` | initMatrix, onSync handler, offline events |
| `src/entities/auth/model/background-sync.ts` | Фоновый polling неактивных аккаунтов |
| `src/shared/lib/local-db/sync-engine.ts` | Offline-first очередь |
| `src/shared/config/constants.ts` | Все URL/хосты |
| `src/entities/chat/model/chat-store.ts` | appStateChange listener (Capacitor resume) |
| `src/shared/lib/tor/tor-service.ts` | Tor-сервис |
| `src/app/providers/chat-scripts/config/pocketnetinstance.ts` | Legacy Pocketnet конфиг |
