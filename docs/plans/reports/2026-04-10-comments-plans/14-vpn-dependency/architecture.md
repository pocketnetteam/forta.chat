# Архитектура: VPN-зависимость

## Связь с проблемой

Пользователи сообщают: «без VPN не работает», «с VPN работает везде», «иногда работает без VPN, иногда нет».

## Сетевые зависимости приложения

Forta Chat для работы требует доступ к нескольким серверам:

| Сервер | Домен | Порт | Протокол | Назначение |
|--------|-------|------|----------|------------|
| Matrix Homeserver | `matrix.pocketnet.app` | 443 | HTTPS | Чаты, sync, push gateway |
| RPC Proxy 1 | `1.pocketnet.app` | 8899 | HTTPS | Блокчейн RPC |
| RPC Proxy 2 | `2.pocketnet.app` | 8899 | HTTPS | Блокчейн RPC |
| RPC Proxy 3 | `6.pocketnet.app` | 8899 | HTTPS | Блокчейн RPC |
| WebSocket | `*.pocketnet.app` | 8099 | WSS | Realtime events |
| WebRTC Signaling | `pocketnet.app` | 9090 | WSS | Звонки |
| WebRTC HTTP | `pocketnet.app` | 9091 | HTTPS | Звонки |
| Upload | `pocketnet.app` | 8092 | HTTPS | Файлы, аватары |

### Критические точки отказа

1. **`matrix.pocketnet.app`** — без него приложение не загружает чаты
2. **`*.pocketnet.app:8899`** — без них не работает регистрация, вход, профиль

## Почему нужен VPN

### Возможные причины блокировки

1. **DNS-блокировка** домена `pocketnet.app` провайдером/государством
2. **IP-блокировка** серверов
3. **DPI (Deep Packet Inspection)** — блокировка по SNI
4. **Нестандартные порты** (8899, 8099, 9090, 9091, 8092) — могут быть заблокированы корпоративными файрволлами
5. **Geo-блокировка** на стороне серверов

### Конфигурация в приложении

**Хардкоженные URL** — нет fallback, нет альтернативных серверов:

```typescript
// src/shared/config/constants.ts
export const MATRIX_SERVER = "matrix.pocketnet.app";
export const PROXY_NODES = [
  { host: "1.pocketnet.app", port: 8899, wss: 8099 },
  { host: "2.pocketnet.app", port: 8899, wss: 8099 },
  { host: "6.pocketnet.app", port: 8899, wss: 8099 }
];
```

**Нет:**
- DNS-over-HTTPS
- Альтернативных доменов / IP
- CDN / edge proxy
- WebSocket fallback для HTTP
- Domain fronting

## Tor (встроенный обход)

### Android (Capacitor)

`src/shared/lib/tor/tor-service.ts`:
- Фоновый Tor-демон через нативный плагин
- Инициализация: `torService.initBackground()` при загрузке (до Matrix)
- Matrix трафик может идти через `127.0.0.1:8181`

```typescript
// stores.ts
if (isNative) {
  const { torService } = await import('@/shared/lib/tor');
  if (torService.matrixBaseUrl) {
    matrixService.setTorProxyUrl(torService.matrixBaseUrl);
  }
}
```

### Electron

`src/shared/lib/transport/init-transport.ts`:
- Service Worker как мост к Tor в main process
- IPC для API calls через Tor

### Web (браузер)

**Tor НЕ доступен** — браузер не может запустить Tor-процесс.

### UI переключатель

`SettingsPage.vue` — секция Tor proxy (видна только на нативе/Electron):
- Toggle вкл/выкл
- Статус подключения
- Диалог предупреждения при отключении

## Capacitor: сетевая конфигурация

```typescript
// capacitor.config.ts
server: {
  androidScheme: 'https'
}
```

- Нет `allowNavigation` для конкретных доменов
- Нет `network_security_config.xml` (cleartext не разрешён)

## Поведение при недоступности серверов

### Matrix homeserver

```
matrixService.init() с таймаутом 45s
  → Ошибка → bootStatus.setError("Matrix server connection timeout")
  → Приложение показывает ошибку загрузки
```

### RPC ноды

```
Пробуется каждая нода из PROXY_NODES поочерёдно
Если все недоступны → ошибка регистрации/входа
```

### Нет graceful degradation

При недоступности Matrix:
- Приложение **не загружается** (зависает на шаге `matrix`)
- Нет кэшированного состояния для offline-просмотра чатов
- `SyncEngine` не может отправлять даже с Dexie (нужен Matrix online для `sendEvent`)

## Диагностика

В приложении **нет:**
- Network diagnostic tool
- Проверки доступности серверов с UI feedback
- Предложения включить VPN
- Логов сетевых ошибок для пользователя

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `src/shared/config/constants.ts` | Все URL и хосты (хардкод) |
| `src/entities/matrix/model/matrix-client.ts` | HTTP transport, Tor proxy |
| `src/entities/auth/model/stores.ts` | initMatrix с таймаутом |
| `src/shared/lib/tor/tor-service.ts` | Tor-демон |
| `src/shared/lib/transport/init-transport.ts` | Electron Tor transport |
| `src/pages/settings/SettingsPage.vue` | Tor toggle |
| `src/app/providers/index.ts` | Boot pipeline, Tor init |
| `capacitor.config.ts` | Network scheme |
| `src/app/providers/chat-scripts/config/pocketnetinstance.ts` | Legacy Pocketnet URLs |
