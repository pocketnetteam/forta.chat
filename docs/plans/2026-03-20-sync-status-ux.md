# Sync Status UX — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Добавить двухуровневую систему индикации синхронизации (global banner + chat subtitle) с anti-flicker debounce, чтобы пользователь понимал, когда данные ещё обновляются.

**Architecture:** Новый feature `sync-status` в FSD-структуре. Composable `useSyncStatus()` (singleton) слушает Matrix SDK sync events и navigator online/offline, вычисляет raw status. `useDebouncedStatus()` применяет delayed-show + min-display anti-flicker. `SyncBanner.vue` монтируется в App.vue. `useChatSyncStatus()` интегрируется в ChatWindow subtitle.

**Tech Stack:** Vue 3, TypeScript, Pinia (read-only), Tailwind CSS, matrix-js-sdk sync events

**Design Doc:** `docs/plans/2026-03-20-sync-status-ux-design.md`

---

### Task 1: Расширить Matrix SDK sync callback для пробрасывания ERROR/STOPPED/RECONNECTING

**Files:**
- Modify: `src/entities/matrix/model/matrix-client.ts:21` (SyncCallback type)
- Modify: `src/entities/matrix/model/matrix-client.ts:321-328` (sync event listener)

**Step 1: Расширить тип SyncCallback**

Строка 21 — изменить:
```typescript
// БЫЛО:
export type SyncCallback = (state: "PREPARED" | "SYNCING") => void;

// СТАЛО:
export type SyncCallback = (state: "PREPARED" | "SYNCING" | "ERROR" | "STOPPED" | "RECONNECTING") => void;
```

**Step 2: Убрать фильтр в sync listener**

Строки 321-328 — изменить:
```typescript
// БЫЛО:
this.client.on("sync", (state: string) => {
  if (state === "PREPARED" || state === "SYNCING") {
    if (!this.chatsReady) {
      this.chatsReady = true;
    }
    this.onSync?.(state as "PREPARED" | "SYNCING");
  }
});

// СТАЛО:
this.client.on("sync", (state: string) => {
  if (state === "PREPARED" || state === "SYNCING") {
    if (!this.chatsReady) {
      this.chatsReady = true;
    }
  }
  this.onSync?.(state as "PREPARED" | "SYNCING" | "ERROR" | "STOPPED" | "RECONNECTING");
});
```

**Step 3: Обновить stores.ts callback для совместимости**

В `src/entities/auth/model/stores.ts:273-276`:
```typescript
// БЫЛО:
onSync: (state) => {
  chatStore.refreshRooms(state);
},

// СТАЛО:
onSync: (state) => {
  if (state === "PREPARED" || state === "SYNCING") {
    chatStore.refreshRooms(state);
  }
},
```

Это гарантирует, что `refreshRooms` вызывается только для прежних двух состояний, а новые состояния (ERROR, STOPPED, RECONNECTING) просто пробрасываются дальше без побочных эффектов.

**Step 4: Commit**

```bash
git add src/entities/matrix/model/matrix-client.ts src/entities/auth/model/stores.ts
git commit -m "feat(sync-status): forward all SDK sync states through callback"
```

---

### Task 2: Создать `useDebouncedStatus()` — anti-flicker engine

**Files:**
- Create: `src/features/sync-status/model/use-debounced-status.ts`

**Step 1: Создать файл**

```typescript
// src/features/sync-status/model/use-debounced-status.ts
import { ref, watch, onUnmounted, type Ref } from "vue";
import type { SyncPhase } from "./use-sync-status";

/** Debounced status для UI — предотвращает мигание индикаторов */
export type DisplayPhase = SyncPhase | "idle";

const SHOW_DELAY: Partial<Record<SyncPhase, number>> = {
  offline: 0,
  error: 0,
  connecting: 300,
  catching_up: 300,
};

const MIN_DISPLAY = 600;
const SUCCESS_SHOW = 800;

function isActivePhase(s: string): boolean {
  return s === "offline" || s === "connecting" || s === "catching_up" || s === "error";
}

export function useDebouncedStatus(raw: Ref<SyncPhase>) {
  const visibleStatus = ref<DisplayPhase>("idle");

  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let successTimer: ReturnType<typeof setTimeout> | null = null;
  let shownAt = 0;

  function clearAll() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (successTimer) { clearTimeout(successTimer); successTimer = null; }
  }

  watch(raw, (next) => {
    // Переход В активный статус
    if (isActivePhase(next)) {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (successTimer) { clearTimeout(successTimer); successTimer = null; }

      const delay = SHOW_DELAY[next] ?? 300;

      // Уже показываем активный — обновляем текст без delay
      if (isActivePhase(visibleStatus.value)) {
        visibleStatus.value = next;
        return;
      }

      if (showTimer) clearTimeout(showTimer);
      showTimer = setTimeout(() => {
        visibleStatus.value = next;
        shownAt = Date.now();
        showTimer = null;
      }, delay);
      return;
    }

    // Переход в syncing или up_to_date
    if (next === "syncing" || next === "up_to_date") {
      // Sync завершился ДО delay — тишина
      if (showTimer !== null) {
        clearTimeout(showTimer);
        showTimer = null;
        return;
      }

      // Индикатор на экране — соблюдаем MIN_DISPLAY
      if (isActivePhase(visibleStatus.value)) {
        const elapsed = Date.now() - shownAt;
        const remaining = Math.max(0, MIN_DISPLAY - elapsed);

        hideTimer = setTimeout(() => {
          hideTimer = null;
          visibleStatus.value = "up_to_date";

          successTimer = setTimeout(() => {
            visibleStatus.value = "idle";
            successTimer = null;
          }, SUCCESS_SHOW);
        }, remaining);
      }
    }
  });

  onUnmounted(clearAll);

  return { visibleStatus };
}
```

**Step 2: Commit**

```bash
git add src/features/sync-status/model/use-debounced-status.ts
git commit -m "feat(sync-status): add anti-flicker debounce engine"
```

---

### Task 3: Создать `useSyncStatus()` — global sync state machine

**Files:**
- Create: `src/features/sync-status/model/use-sync-status.ts`

**Step 1: Создать файл**

```typescript
// src/features/sync-status/model/use-sync-status.ts
import { ref, computed, watch, type Ref, type ComputedRef } from "vue";
import { useConnectivity } from "@/shared/lib/connectivity";
import { useDebouncedStatus, type DisplayPhase } from "./use-debounced-status";

export type SyncPhase =
  | "offline"
  | "connecting"
  | "catching_up"
  | "syncing"
  | "up_to_date"
  | "error";

export interface SyncStatusReturn {
  rawStatus: Readonly<Ref<SyncPhase>>;
  displayStatus: Readonly<Ref<DisplayPhase>>;
  showBanner: ComputedRef<boolean>;
  bannerText: ComputedRef<string>;
  bannerVariant: ComputedRef<"warning" | "info" | "success" | "error">;
}

const RECONNECT_THRESHOLD = 5_000;

// Singleton state — живёт за пределами composable
const rawStatus = ref<SyncPhase>("connecting");
let lastUpToDateAt = 0;
let initialized = false;

/**
 * Вызывается из stores.ts onSync callback.
 * Не зависит от Vue lifecycle — можно вызывать до монтирования компонентов.
 */
export function handleSdkSync(sdkState: string): void {
  // Если navigator offline — всегда offline, независимо от SDK
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    rawStatus.value = "offline";
    return;
  }

  switch (sdkState) {
    case "PREPARED": {
      lastUpToDateAt = Date.now();
      rawStatus.value = "up_to_date";
      break;
    }
    case "SYNCING": {
      const gap = Date.now() - lastUpToDateAt;
      rawStatus.value = gap > RECONNECT_THRESHOLD ? "catching_up" : "syncing";
      break;
    }
    case "ERROR":
    case "STOPPED":
      rawStatus.value = "error";
      break;
    case "RECONNECTING":
      rawStatus.value = "connecting";
      break;
  }
}

/**
 * Global sync status composable (singleton).
 * Вызывай из любого компонента — возвращает один и тот же reactive state.
 */
export function useSyncStatus(): SyncStatusReturn {
  if (!initialized) {
    initialized = true;
    const { isOnline } = useConnectivity();

    watch(isOnline, (online) => {
      if (!online) {
        rawStatus.value = "offline";
      } else if (rawStatus.value === "offline") {
        // Сеть восстановлена — SDK сам reconnect-ится, ставим connecting
        rawStatus.value = "connecting";
      }
    });
  }

  const { visibleStatus } = useDebouncedStatus(rawStatus);

  const showBanner = computed(() => {
    const s = visibleStatus.value;
    return s !== "idle" && s !== "syncing";
  });

  const bannerText = computed(() => {
    switch (visibleStatus.value) {
      case "offline": return "Ожидание сети...";
      case "connecting": return "Соединение...";
      case "catching_up": return "Обновление...";
      case "up_to_date": return "Обновлено";
      case "error": return "Не удалось подключиться";
      default: return "";
    }
  });

  const bannerVariant = computed<"warning" | "info" | "success" | "error">(() => {
    switch (visibleStatus.value) {
      case "offline":
      case "connecting": return "warning";
      case "catching_up": return "info";
      case "up_to_date": return "success";
      case "error": return "error";
      default: return "info";
    }
  });

  return { rawStatus, displayStatus: visibleStatus, showBanner, bannerText, bannerVariant };
}
```

**Step 2: Commit**

```bash
git add src/features/sync-status/model/use-sync-status.ts
git commit -m "feat(sync-status): add global sync state machine composable"
```

---

### Task 4: Создать `useChatSyncStatus()` — per-room composable

**Files:**
- Create: `src/features/sync-status/model/use-chat-sync-status.ts`

**Step 1: Создать файл**

```typescript
// src/features/sync-status/model/use-chat-sync-status.ts
import { ref, computed, watch, type Ref, type ComputedRef } from "vue";
import { useSyncStatus, type SyncPhase } from "./use-sync-status";

export interface ChatSyncReturn {
  isFresh: Readonly<Ref<boolean>>;
  syncSubtitle: ComputedRef<string | null>;
}

export function useChatSyncStatus(roomId: Ref<string | null>): ChatSyncReturn {
  const { rawStatus } = useSyncStatus();
  const isFresh = ref(false);

  // Сбрасываем при смене комнаты
  watch(roomId, () => {
    // Если global уже up_to_date — комната сразу fresh
    isFresh.value = rawStatus.value === "up_to_date" || rawStatus.value === "syncing";
  });

  // Обновляем при изменении global sync
  watch(rawStatus, (next) => {
    if (next === "up_to_date" && roomId.value) {
      isFresh.value = true;
    }
    if (next === "catching_up" || next === "offline" || next === "error") {
      isFresh.value = false;
    }
  });

  const syncSubtitle = computed<string | null>(() => {
    if (isFresh.value) return null;

    switch (rawStatus.value) {
      case "catching_up":
      case "connecting": return "Обновление...";
      case "offline": return "Ожидание сети...";
      case "error": return "Нет соединения";
      default: return null;
    }
  });

  return { isFresh, syncSubtitle };
}
```

**Step 2: Commit**

```bash
git add src/features/sync-status/model/use-chat-sync-status.ts
git commit -m "feat(sync-status): add per-room chat sync status composable"
```

---

### Task 5: Создать public API и `SyncBanner.vue`

**Files:**
- Create: `src/features/sync-status/index.ts`
- Create: `src/features/sync-status/ui/SyncBanner.vue`

**Step 1: Создать index.ts**

```typescript
// src/features/sync-status/index.ts
export { useSyncStatus, handleSdkSync, type SyncPhase } from "./model/use-sync-status";
export { useChatSyncStatus } from "./model/use-chat-sync-status";
export { default as SyncBanner } from "./ui/SyncBanner.vue";
```

**Step 2: Создать SyncBanner.vue**

```vue
<!-- src/features/sync-status/ui/SyncBanner.vue -->
<script setup lang="ts">
import { computed } from "vue";
import { useSyncStatus } from "../model/use-sync-status";

const { displayStatus, showBanner, bannerText, bannerVariant } = useSyncStatus();

const isSpinning = computed(() =>
  displayStatus.value === "connecting" || displayStatus.value === "catching_up",
);
const isSuccess = computed(() => displayStatus.value === "up_to_date");
const isError = computed(() => displayStatus.value === "error");
</script>

<template>
  <transition name="sync-banner">
    <div
      v-if="showBanner"
      class="flex items-center justify-center gap-1.5 px-4 py-1 text-xs leading-tight"
      :class="{
        'bg-red-500/10 text-red-400': bannerVariant === 'error',
        'bg-amber-500/10 text-amber-400': bannerVariant === 'warning',
        'bg-sky-500/10 text-sky-400': bannerVariant === 'info',
        'bg-emerald-500/10 text-emerald-400': bannerVariant === 'success',
      }"
    >
      <!-- Spinner -->
      <svg
        v-if="isSpinning"
        class="h-3 w-3 animate-spin"
        viewBox="0 0 16 16"
        fill="none"
      >
        <circle
          cx="8" cy="8" r="6"
          stroke="currentColor"
          stroke-width="2"
          stroke-dasharray="28"
          stroke-dashoffset="8"
        />
      </svg>

      <!-- Checkmark -->
      <svg v-else-if="isSuccess" class="h-3 w-3" viewBox="0 0 16 16" fill="none">
        <path d="M3 8l4 4 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>

      <!-- Alert -->
      <svg v-else-if="isError" class="h-3 w-3" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" />
        <path d="M8 5v4M8 11v0.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>

      <span>{{ bannerText }}</span>
    </div>
  </transition>
</template>

<style scoped>
.sync-banner-enter-active,
.sync-banner-leave-active {
  transition: max-height 200ms ease, opacity 200ms ease;
  overflow: hidden;
}
.sync-banner-enter-from,
.sync-banner-leave-to {
  max-height: 0;
  opacity: 0;
}
.sync-banner-enter-to,
.sync-banner-leave-from {
  max-height: 28px;
  opacity: 1;
}
</style>
```

**Step 3: Commit**

```bash
git add src/features/sync-status/
git commit -m "feat(sync-status): add SyncBanner component and public API"
```

---

### Task 6: Wiring — подключить sync status к Matrix SDK и UI

**Files:**
- Modify: `src/entities/auth/model/stores.ts:273-276`
- Modify: `src/app/App.vue:144-145` (template)
- Modify: `src/app/App.vue:1-12` (imports)
- Modify: `src/widgets/chat-window/ChatWindow.vue:175-179` (subtitle computed)
- Modify: `src/widgets/chat-window/ChatWindow.vue:281-286` (template subtitle)

**Step 1: Подключить handleSdkSync в stores.ts**

Строки 273-276 — изменить:
```typescript
// Добавить импорт вверху файла:
import { handleSdkSync } from "@/features/sync-status";

// Изменить onSync handler:
onSync: (state) => {
  if (state === "PREPARED" || state === "SYNCING") {
    chatStore.refreshRooms(state);
  }
  handleSdkSync(state);
},
```

**Step 2: Добавить SyncBanner в App.vue**

В секции imports добавить:
```typescript
import { SyncBanner } from "@/features/sync-status";
```

В template, строка 144 — между TitleBar и div.flex-1:
```vue
<TitleBar v-if="isElectron" />
<SyncBanner />
<div class="relative min-h-0 flex-1 overflow-hidden">
```

**Step 3: Интегрировать chat sync в ChatWindow subtitle**

В секции imports ChatWindow.vue добавить:
```typescript
import { useChatSyncStatus } from "@/features/sync-status";
```

В script setup, после объявления chatStore:
```typescript
const { syncSubtitle } = useChatSyncStatus(
  computed(() => chatStore.activeRoomId),
);
```

Изменить subtitle computed (строка 175):
```typescript
// БЫЛО:
const subtitle = computed(() => {
  if (typingText.value) return typingText.value;
  const room = chatStore.activeRoom;
  if (!room) return "";
  if (room.isGroup) return t("chat.members", { count: room.members.length });
  return "";
});

// СТАЛО:
const subtitle = computed(() => {
  if (typingText.value) return typingText.value;
  if (syncSubtitle.value) return syncSubtitle.value;
  const room = chatStore.activeRoom;
  if (!room) return "";
  if (room.isGroup) return t("chat.members", { count: room.members.length });
  return "";
});
```

Изменить CSS-класс subtitle в template (строка 281-286):
```vue
<!-- БЫЛО: -->
<div
  class="text-xs"
  :class="typingText ? 'text-color-bg-ac' : 'text-text-on-main-bg-color'"
>
  {{ subtitle }}
</div>

<!-- СТАЛО: -->
<div
  class="text-xs"
  :class="
    typingText
      ? 'text-color-bg-ac'
      : syncSubtitle
        ? 'text-muted-foreground'
        : 'text-text-on-main-bg-color'
  "
>
  {{ subtitle }}
</div>
```

**Step 4: Commit**

```bash
git add src/entities/auth/model/stores.ts src/app/App.vue src/widgets/chat-window/ChatWindow.vue
git commit -m "feat(sync-status): wire banner into App and sync subtitle into ChatWindow"
```

---

### Task 7: Ручное тестирование сценариев

**Сценарии для проверки:**

**7a. Холодный старт:**
1. Открыть приложение
2. Проверить: если sync > 300ms → появляется banner "Соединение..."
3. После sync → "Обновлено" (800ms) → исчезает
4. Если sync < 300ms → banner вообще не появляется

**7b. Потеря сети:**
1. DevTools → Network → Offline
2. Проверить: banner "Ожидание сети..." появляется мгновенно (delay=0)
3. Включить сеть обратно
4. Проверить: banner переходит в "Соединение..." → "Обновление..." → "Обновлено" → скрыть

**7c. Открытие чата при catching_up:**
1. Перевести в offline
2. Включить сеть
3. Быстро открыть чат
4. Проверить: subtitle показывает "Обновление..." пока sync не завершится

**7d. Обычная работа (online, всё синхронизировано):**
1. Открыть чат
2. Проверить: никаких индикаторов, subtitle = "N участников"
3. Подождать 60с+ (delta sync)
4. Проверить: никакого мигания (обычный syncing скрыт)

**7e. Anti-flicker:**
1. Быстрый интернет — убедиться что ничего не мигает при холодном старте
2. Throttle до Slow 3G — убедиться что индикатор появляется и держится

**Step: Commit финальный (если были правки после тестирования)**

```bash
git commit -m "fix(sync-status): adjustments from manual testing"
```
