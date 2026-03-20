# Sync Status UX — Design Document

**Date**: 2026-03-20
**Status**: Approved
**Problem**: При открытии приложения или чата пользователь видит stale данные из Dexie и не понимает, что sync ещё идёт.
**Solution**: Двухуровневая система индикации (global banner + chat subtitle) с anti-flicker debounce.

---

## 1. State Machine синхронизации

### Global Sync Status

```
              ┌──────────┐   SDK connected    ┌───────────┐
  App start──►│ OFFLINE  │───────────────────►│CONNECTING │
              └──────────┘                    └─────┬─────┘
                    ▲                               │ onSync("PREPARED")
                    │ navigator offline /            ▼
                    │ SDK error               ┌───────────┐
              ┌─────┴──────┐  gap > 5s  ◄─── │ CATCHING  │
              │   SYNCING   │                 │    UP     │
              │ (delta, hidden)│               └─────┬─────┘
              └─────┬──────┘                        │ onSync("PREPARED")
                    │ onSync("PREPARED")             ▼
                    ▼                          ┌──────────┐
              ┌──────────┐ ◄───────────────── │UP_TO_DATE│
              │UP_TO_DATE│                     └──────────┘
              └──────────┘
```

| State | Meaning | UI |
|-------|---------|-----|
| `offline` | Нет сети / SDK остановлен | "Ожидание сети..." |
| `connecting` | SDK стартует, sync не было | "Соединение..." |
| `catching_up` | Первый sync после reconnect (gap > 5s) | "Обновление..." |
| `syncing` | Обычный delta poll (каждые 60с) | Скрыт |
| `up_to_date` | Данные актуальны | Кратковременно "Обновлено" |
| `error` | SDK ошибка | "Не удалось подключиться" + кнопка Retry |

**Ключевое решение**: `syncing` (обычный 60s poll) не показывается. `catching_up` определяется по gap > 5s с последнего `up_to_date`.

### Chat-Level Sync Status

```
  Открыл чат ──► STALE (Dexie данные, sync не прошёл)
                     │
                     │ global → up_to_date
                     ▼
                  FRESH (данные актуальны)
                     │
                     │ global → catching_up / offline
                     ▼
                  STALE (снова)
```

---

## 2. UX/UI Паттерны

### Global Banner (AppHeader)

Тонкая полоска (28px) между AppHeader и контентом. `transition: max-height 200ms`.

| Global Status | Banner | Цвет | Иконка |
|---------------|--------|------|--------|
| `offline` | "Ожидание сети..." | `bg-warning/10` | wifi-off |
| `connecting` | "Соединение..." | `bg-warning/10` | spinner |
| `catching_up` | "Обновление..." | `bg-primary/10` | spinner |
| `error` | "Не удалось подключиться" | `bg-destructive/10` | alert + Retry |
| `syncing` | — скрыт — | — | — |
| `up_to_date` | "Обновлено" (800ms) | `bg-success/10` | checkmark |

### Chat Subtitle

Приоритет subtitle (от высшего к низшему):
1. **Typing indicator** ("Алиса печатает...") — всегда главнее
2. **Sync status** ("Обновление...") — только когда stale
3. **Default** ("3 участника" / пусто для DM)

---

## 3. Anti-Flicker / Debounce

### Три таймера

| Timer | Value | Purpose |
|-------|-------|---------|
| `SHOW_DELAY` | 300ms | Не показывать индикатор если sync быстрее |
| `MIN_DISPLAY` | 600ms | Минимум показа (нет мигания) |
| `SUCCESS_DISPLAY` | 800ms | Длительность "Обновлено" |

### Особые delay по статусам

| Status | SHOW_DELAY | Reason |
|--------|------------|--------|
| `offline` | 0ms | Критично, показываем сразу |
| `error` | 0ms | Критично |
| `connecting` | 300ms | Может быть быстрый reconnect |
| `catching_up` | 300ms | Может быть маленький delta |

### Алгоритм

```
Быстрый sync (<300ms): ничего не показываем
Средний sync (800ms):  300ms ждём → показываем → MIN_DISPLAY → "Обновлено" 800ms → idle
Долгий sync (5s+):     300ms ждём → показываем всё время → "Обновлено" 800ms → idle
```

---

## 4. Архитектура (псевдокод)

### File Structure (FSD)

```
src/features/sync-status/
├── index.ts
├── model/
│   ├── use-sync-status.ts        # global sync state machine (singleton)
│   ├── use-chat-sync-status.ts   # per-room sync state
│   └── use-debounced-status.ts   # anti-flicker engine
└── ui/
    └── SyncBanner.vue            # global banner component
```

### `useSyncStatus()` — Global Composable

```typescript
export type SyncPhase =
  | 'offline' | 'connecting' | 'catching_up'
  | 'syncing' | 'up_to_date' | 'error'

// Singleton. Слушает:
// - navigator online/offline через useConnectivity()
// - Matrix SDK sync events через handleSdkSync() callback
// Определяет catching_up vs syncing по gap > RECONNECT_THRESHOLD (5s)
// Пробрасывает rawStatus в useDebouncedStatus() для UI
```

### `useDebouncedStatus()` — Anti-Flicker Engine

```typescript
// watch(rawStatus) →
//   Активный статус: setTimeout(SHOW_DELAY) → show
//   up_to_date:
//     если show timer pending → cancel (тишина)
//     если индикатор на экране → wait(MIN_DISPLAY) → "Обновлено" → wait(SUCCESS) → idle
```

### `useChatSyncStatus(roomId)` — Per-Room Composable

```typescript
// isFresh = false при открытии комнаты
// isFresh = true когда global → up_to_date
// isFresh = false когда global → catching_up / offline
// syncSubtitle: computed string | null для subtitle
```

### Wiring

- `stores.ts`: `onSync` callback пробрасывает в `useSyncStatus._handleSdkSync()`
- `App.vue`: `<SyncBanner />` между TitleBar и router-view
- `ChatWindow.vue`: subtitle computed использует `useChatSyncStatus()`

---

## 5. Сценарии

**Холодный старт**: Dexie мгновенно → banner "Соединение..." (если >300ms) → sync → "Обновлено" → скрыть

**Открытие чата после offline**: Dexie мгновенно → subtitle "Обновление..." → sync → "Обновлено" → "3 участника"

**Обычная работа (online)**: Никаких индикаторов. Чат сразу fresh.

**Быстрый sync (<300ms)**: Ничего не мигает. Пользователь не заметил.
