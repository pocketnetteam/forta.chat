# Android: пустой чат при открытии + ненадёжная отправка — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> **Контекст:** Аудит репозитория за ~2 месяца (май–июнь 2026). Жалобы пользователей на Android:
> 1. Тап по чату в списке → чат «не показывается» (пустой экран / остаётся список).
> 2. Сообщения и изображения часто не уходят (зависают в sending или падают в failed).

**Goal:** Стабильное открытие чата из sidebar на Android и надёжная доставка исходящих (текст + медиа) после sleep/wake, handover WiFi↔LTE и при медленном IndexedDB.

**Architecture:** Два независимых кластера с общей точкой отказа — **Android WebView + IndexedDB + Matrix /sync**:

| Кластер | Read path (открытие чата) | Write path (отправка) |
|---------|---------------------------|------------------------|
| Симптом | Пустой ChatWindow, skeleton >3с, sidebar не уходит | Сообщение в UI как sending/failed, `pendingOps` не дренируется |
| Ключевые модули | `ChatPage`, `setActiveRoom` (WEE-95), `MessageList`, `useLiveQuery` | `SyncEngine`, `onConnectivityChange`, `MatrixClientService` (WEE-105) |
| Вероятные регрессии | `7f8fd81`, `acf6a60` (WEE-95), `d40760c` (WEE-97 IDB contention) | `1b7ff66` (WEE-105), `297aa6e` (WEE-94), Session 49 watchdog gap (30с) |

**Tech Stack:** Vue 3, Pinia, Dexie, Capacitor (`@capacitor/app`, `@capacitor/network`), matrix-js-sdk-bastyon, Vitest

**Связанные тикеты (уже в коде):** WEE-55, WEE-80, WEE-84, WEE-85, WEE-93, WEE-94, WEE-95, WEE-97, WEE-105

**Не в scope этого плана:** клавиатура (параллельная работа другого разработчика), звонки, каналы.

---

## Диагностика перед фиксом (обязательно)

Перед каждой фазой — воспроизведение с Chrome Remote Debugging (`chrome://inspect` → WebView Forta Chat).

### Чеклист «чат не открывается»

- [ ] При тапе меняется ли `chatStore.activeRoomId`?
- [ ] `ChatPage.showSidebar` → `false`?
- [ ] `chatStore.activeMessages.length` и `activeMessages[0]?.roomId === activeRoomId`?
- [ ] В консоли: `[MessageList] settled safety timeout`?
- [ ] `MessageList`: `switching`, `loading`, `settled`, `loadEverAttempted`?
- [ ] IndexedDB → `messages` для `roomId` — есть строки?

### Чеклист «не отправляется»

- [ ] Сообщение видно в ленте (optimistic) или пропало совсем?
- [ ] `authStore.matrixReady`, sync state (`ERROR` / `RECONNECTING`)?
- [ ] IndexedDB → `pendingOps` — status `pending` / `syncing` / `failed`?
- [ ] Лог `[SyncEngine] watchdog: ... forcing setOnline(true)`?
- [ ] Только медиа или и текст?

### Сравнение версий (если регрессия неочевидна)

| Build | Назначение |
|-------|------------|
| `v1.9.0` | До WEE-95 / WEE-97 |
| `v1.9.5` | Перед WEE-105 |
| `HEAD` | Текущее состояние |

---

## Phase 1 — Открытие чата из списка (Read path)

### Task 1.1: Увеличить устойчивость `waitForRoomMessages` на native

**Почему:** После WEE-95 `setActiveRoom` синхронно вызывает `resetDexieMessages([])`. На медленном Android IDB первый emission `liveQuery` может прийти позже 2 с — `MessageList` уходит в `loadMessages` + `loading=true`, скроллер не монтируется (`v-if="!loading"`).

**Files:**
- Modify: `src/features/messaging/ui/MessageList.vue` (~`waitForRoomMessages`, room-switch watcher)
- Test: `src/features/messaging/ui/__tests__/message-list-room-switch.test.ts` (создать)

**Step 1: Write failing test**

Тест: при смене `activeRoomId` и задержанном `dexieMessages` (mock) — `settled` становится `true` в пределах увеличенного timeout на `isNative`.

**Step 2: Implement**

```typescript
import { isNative } from "@/shared/lib/platform";

const ROOM_MESSAGES_WAIT_MS = isNative ? 5_000 : 2_000;
// использовать ROOM_MESSAGES_WAIT_MS в waitForRoomMessages и при peek→wait
```

**Step 3: Verify**

```bash
npx vitest run src/features/messaging/ui/__tests__/message-list-room-switch.test.ts
```

**Step 4: Commit**

```bash
git commit -m "fix(messaging): longer liveQuery wait on native when opening chat (WEE-95)"
```

---

### Task 1.2: Не блокировать reveal скроллера флагом `loading` при наличии кэша в Dexie

**Почему:** `ChatVirtualScroller` с `v-if="!loading"` — при `loading=true` пользователь видит только skeleton, даже если `loadCachedMessages` / peek уже нашли сообщения в IDB.

**Files:**
- Modify: `src/features/messaging/ui/MessageList.vue` (room-switch watcher, ~строки 716–780)

**Step 1: Write failing test**

Mock: `getMessages(roomId, 1)` возвращает 1 сообщение, `activeMessages` ещё пустой → после watcher `loading` должен быть `false`, scroller mountable.

**Step 2: Implement**

После успешного `peek.length > 0` и `waitForRoomMessages`:
- если `activeMessages` всё ещё пустой, но peek не пустой — **не** ставить `loading=true` для полного `loadMessages`; вместо этого дождаться liveQuery или вызвать `chatStore.loadCachedMessages` и перейти к PHASE 3 reveal.
- Альтернатива (минимальный diff): заменить `v-if="!loading"` на `v-if="!loading || chatStore.activeMessages.length > 0"`.

**Step 3: Verify**

```bash
npx vitest run src/features/messaging/ui/__tests__/message-list-room-switch.test.ts
npm run build
```

**Step 4: Commit**

```bash
git commit -m "fix(messaging): show scroller when Dexie cache exists but liveQuery lags"
```

---

### Task 1.3: Смягчить двойной bump `_liveQueryGen` в `setActiveRoom`

**Почему:** Синхронный `_liveQueryGen++` + повтор после `flushWriteBuffer` даёт две переподписки liveQuery подряд → лишняя конкуренция за IDB lock на Android.

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts` (`setActiveRoom`, ~3490–3506)
- Test: `src/entities/chat/model/chat-store-room-switch.test.ts` (расширить)

**Step 1: Write failing test**

При смене комнаты `_liveQueryGen` увеличивается ровно один раз до первого emission (mock flush resolving immediately).

**Step 2: Implement**

Вариант A (предпочтительный):
- Оставить синхронный reset + `_liveQueryGen++` при смене roomId.
- Убрать второй bump в `flushPromise.then` **или** объединить: bump только если flush реально записал buffered messages для **предыдущей** комнаты (проверка через `writeBuffer.pendingCount`).

Вариант B (fallback):
- Второй bump отложить в `requestAnimationFrame` + guard `activeRoomId === roomId`.

**Step 3: Verify**

```bash
npx vitest run src/entities/chat/model/chat-store-room-switch.test.ts
```

**Step 4: Commit**

```bash
git commit -m "perf(chat-open): avoid double liveQuery resubscribe on room switch"
```

---

### Task 1.4: Защита `ChatPage` — sidebar не перекрывает чат при гонке

**Почему:** `userForcedSidebar` сбрасывается watcher'ом на `activeRoomId`, но при медленном `setActiveRoom` возможен кадр, когда sidebar виден поверх пустого ChatWindow.

**Files:**
- Modify: `src/pages/chat/ChatPage.vue`
- Test: `src/pages/chat/__tests__/ChatPage.test.ts` (расширить)

**Step 1: Test**

Mobile + `activeRoomId` set + `userForcedSidebar=false` → ChatWindow `v-show` true.

**Step 2: Implement (если тест падает)**

В `onSelectRoom` из sidebar — уже сбрасывает `userForcedSidebar`. Дополнительно: в `handleSelect` ContactList порядок уже правильный (`setActiveRoom` до emit). Проверить, что `ctxMenu.show` не залипает после long-press (добавить `onPointerUp` dismiss если нужно — отдельный микро-фикс).

**Step 3: Commit**

```bash
git commit -m "fix(chat): ensure mobile ChatWindow visible when room selected"
```

---

## Phase 2 — Отправка сообщений и медиа (Write path)

### Task 2.1: Resume SyncEngine + Matrix при возврате из background (native)

**Почему:** После sleep/wake Android WebView часто не шлёт `window.online`, хотя `navigator.onLine === true`. Watchdog SyncEngine тикает раз в **30 с** — до этого исходящие стоят в `pending`. `App.vue` уже дергает `retryImmediately()` для push-deeplink, но не для обычного resume.

**Files:**
- Create: `src/shared/lib/composables/use-sync-resume-kick.ts`
- Modify: `src/app/App.vue` (вызов рядом с `useResumeRedirect`)
- Test: `src/shared/lib/composables/use-sync-resume-kick.test.ts`

**Step 1: Write failing test**

Mock `CapApp.addListener('appStateChange')` → `isActive: true` после паузы >0 ms:
- `syncEngine.setOnline(true)` вызван
- `matrixService.client.retryImmediately()` вызван (если ready)

**Step 2: Implement**

```typescript
// use-sync-resume-kick.ts — только isNative
CapApp.addListener("appStateChange", ({ isActive }) => {
  if (!isActive) return;
  if (!authStore.matrixReady) return;
  chatDbKit?.syncEngine.setOnline(true);
  getMatrixClientService().kickSync?.(); // или retryImmediately()
});
```

Подключить в `App.vue` после auth bootstrap (когда `initChatDb` уже вызван).

**Step 3: Verify**

```bash
npx vitest run src/shared/lib/composables/use-sync-resume-kick.test.ts
```

**Step 4: Commit**

```bash
git commit -m "fix(sync): kick outbound queue and Matrix sync on Android app resume"
```

---

### Task 2.2: Уменьшить интервал watchdog SyncEngine на native

**Почему:** 30 с — слишком долго для UX «сообщение не ушло». Session 49 добавил watchdog; WEE-94 расширил lease logic.

**Files:**
- Modify: `src/shared/lib/local-db/sync-engine.ts` (`WATCHDOG_INTERVAL_MS`)
- Test: `src/shared/lib/local-db/__tests__/sync-engine-watchdog.test.ts` (обновить ожидания)

**Step 1: Implement**

```typescript
import { isNative } from "@/shared/lib/platform";

const WATCHDOG_INTERVAL_MS = isNative ? 10_000 : 30_000;
```

Не уменьшать ниже 5 с — лишняя нагрузка на IDB.

**Step 2: Verify**

```bash
npx vitest run src/shared/lib/local-db/__tests__/sync-engine-watchdog.test.ts
```

**Step 3: Commit**

```bash
git commit -m "fix(sync): faster SyncEngine watchdog on native after wake"
```

---

### Task 2.3: Явный kick очереди при переходе Matrix `isReady` false → true

**Почему:** WEE-85 держит ops в `pending` пока `!isMatrixReady()`, но нет события «client ready» → только poll 1 с + watchdog. После WEE-105 mirror failover client пересоздаётся.

**Files:**
- Modify: `src/entities/matrix/model/matrix-client.ts` (после successful `startClient` / failover recreate)
- Modify: `src/entities/auth/model/stores.ts` (`onSync` PREPARED branch)
- Test: `src/shared/lib/local-db/__tests__/sync-engine-matrix-ready.test.ts` (создать)

**Step 1: Write test**

Matrix mock: `isReady` false → enqueue → true → `processQueue` вызван без 30 с ожидания.

**Step 2: Implement**

В `onSync(PREPARED)` или в `matrix-client` после `chatsReady = true`:

```typescript
if (isChatDbReady()) {
  getChatDb().syncEngine.setOnline(true);
}
```

Guard: idempotent, не вызывать на каждый SYNCING tick (только PREPARED или edge reconnect).

**Step 3: Commit**

```bash
git commit -m "fix(messaging): flush SyncEngine when Matrix client becomes ready"
```

---

### Task 2.4: UI — surfaced queue health в ConnectionStatus / subtitle

**Почему:** WEE-20 добавил `getQueueHealth()` — пользователь не видит, что очередь застряла.

**Files:**
- Modify: `src/widgets/sidebar/ui/ConnectionStatusHeader.vue` или `src/features/sync-status/`
- Modify: `src/shared/lib/local-db/sync-engine.ts` (уже есть `getQueueHealth`)
- Test: smoke test на composable

**Step 1: Implement**

Периодический poll (30 с) или при tap на banner:
- `pendingOps > 0` && `navigator.onLine` → «Ожидание отправки (N)»
- Кнопка «Повторить» → `syncEngine.setOnline(true)` + `retryAllFailed()`

**Step 2: Commit**

```bash
git commit -m "fix(messaging): show stuck outbound queue hint on Android"
```

---

## Phase 3 — Стабильность Matrix /sync (если Phase 2 недостаточно)

### Task 3.1: Телеметрия WEE-105 failover

**Почему:** `1b7ff66` — новый failover; если жалобы начались после релиза с WEE-105, нужны логи.

**Files:**
- Modify: `src/entities/matrix/model/matrix-client.ts`, `sync-failover.ts`

**Step 1: Implement**

`console.info` (или opt-in diagnostic flag WEE-39):
- `[matrix] sync failover: ${oldHost} → ${newHost}`
- `[matrix] sync watchdog: stuck in ERROR, attempt ${n}`

**Step 2: Commit**

```bash
git commit -m "chore(matrix): diagnostic logging for sync failover (WEE-105)"
```

---

### Task 3.2: Регрессионный тест failover не ломает `isReady`

**Files:**
- Test: `src/entities/matrix/model/__tests__/sync-failover.test.ts` (расширить)

**Step 1:** После `onFailover` mock recreate → `isReady() === true`, `setOnline(true)` callable.

---

## Phase 4 — IDB contention (если Phase 1 недостаточно)

### Task 4.1: Не запускать deferred recovery во время активного `setActiveRoom`

**Почему:** WEE-97 откладывает `recoverStrandedOps`, `healCrossDeviceMessages` до `signalChatsInteractive`, но они всё равно конкурируют с liveQuery при открытии чата.

**Files:**
- Modify: `src/shared/lib/local-db/index.ts` (`runDeferredRecovery`)
- Modify: `src/shared/lib/boot-signals.ts` (опционально: `whenChatsInteractive` + idle callback)

**Step 1: Implement**

Обёртка `requestIdleCallback` / `setTimeout(0)` + проверка `document.visibilityState` перед тяжёлыми scan.

**Step 2: Commit**

```bash
git commit -m "perf(boot): defer heavy IDB recovery until idle to unblock chat open"
```

---

## Phase 5 — Финальная верификация

### Task 5.1: Полный CI pipeline

```bash
npm run build
npm run lint
npx vue-tsc --noEmit
npm run test
```

### Task 5.2: Manual test matrix (Android 7–14, минимум 2 OEM)

| # | Сценарий | Ожидание |
|---|----------|----------|
| 1 | Cold start → тап в чат с историей | Лента <2 с, без вечного skeleton |
| 2 | Чат A → чат B → назад → чат A | Нет пустого экрана, нет flash чужих сообщений |
| 3 | Отправить текст при хорошей сети | Сразу в ленте, статус sent ≤3 с |
| 4 | Отправить фото 2–5 MB на LTE | Progress, не failed без причины |
| 5 | Background 2 мин → foreground → отправить | Уходит без ручного retry |
| 6 | Airplane mode on → off → retry | Очередь дренируется, failed можно retry |
| 7 | 50+ чатов, открыть старый чат внизу списка | Не tombstone, не пустой (WEE-84) |

### Task 5.3: Code review

- `review` — для этого плана (обычный архитектурный ревью)
- При >7 изменённых файлов в Phase 2+3 — `review-fix`

---

## Порядок выполнения (рекомендуемый)

```
Phase 1 (Tasks 1.1 → 1.2 → 1.3)     ← симптом «чат не показывается»
    ↓ manual test matrix #1–2
Phase 2 (Tasks 2.1 → 2.2 → 2.3)     ← симптом «не отправляется»
    ↓ manual test matrix #3–6
Phase 2.4 (UX)                       ← по желанию, но полезно для поддержки
Phase 3                              ← если sync ERROR в логах
Phase 4                              ← если settled safety timeout + медленный IDB
Phase 5
```

**Правило:** одна задача = один коммит. Conventional Commits: `fix(messaging):`, `fix(sync):`, `perf(chat-open):`.

---

## Worktree

По `CLAUDE.md` — каждая фаза в **изолированном git worktree** (`isolation: worktree` / EnterWorktree), чтобы не конфликтовать с параллельными сессиями.

---

## Критерии готовности (Definition of Done)

- [ ] Manual test matrix #1–6 пройдена на ≥2 Android-устройствах
- [ ] Новые/обновлённые unit-тесты зелёные
- [ ] `npm run build` + `npm run test` зелёные
- [ ] Нет регрессии WEE-84 (re-entry), WEE-80 (skeleton на offline read), WEE-95 (no flash wrong room)
- [ ] Code review пройден

---

## Ссылки на код (якоря)

| Модуль | Путь |
|--------|------|
| Выбор комнаты | `src/features/contacts/ui/ContactList.vue` → `setActiveRoom` |
| Mobile layout | `src/pages/chat/ChatPage.vue` → `showSidebar` |
| Смена комнаты | `src/entities/chat/model/chat-store.ts` → `setActiveRoom` |
| Лента | `src/features/messaging/ui/MessageList.vue` → room watcher, `settled` |
| Очередь отправки | `src/shared/lib/local-db/sync-engine.ts` |
| Connectivity | `src/shared/lib/connectivity.ts` → `onConnectivityChange` |
| Matrix sync | `src/entities/matrix/model/matrix-client.ts`, `sync-failover.ts` |
| Resume redirect | `src/shared/lib/composables/use-resume-redirect.ts` |
