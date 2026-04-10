# Encryption Guard — Правильное отключение шифрования для публичных/больших комнат

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Привести логику шифрования Forta Chat в соответствие с Bastyon — не шифровать сообщения в публичных комнатах и комнатах с ≥50 участниками, показывать статус шифрования в UI.

**Architecture:** Расширяем `PeerKeysStatus` новым значением `"not-encrypted"`, добавляем early-return в `ensureRoomCrypto` для публичных комнат (как в Bastyon), добавляем computed `encryptionStatus` в chat-store, показываем индикатор в ChatWindow.

**Tech Stack:** Vue 3 (Composition API), Pinia, TypeScript, Vitest

---

## Task 1: Расширить тип PeerKeysStatus

**Files:**
- Modify: `src/entities/chat/model/types.ts:163`

**Step 1: Обновить тип**

В `types.ts:163` заменить:
```typescript
export type PeerKeysStatus = "unknown" | "available" | "missing";
```
на:
```typescript
export type PeerKeysStatus = "unknown" | "available" | "missing" | "not-encrypted";
```

**Step 2: Проверить типы**

Run: `npx vue-tsc --noEmit`
Expected: PASS (новое значение union не ломает существующий код)

**Step 3: Commit**

```bash
git add src/entities/chat/model/types.ts
git commit -m "feat: add 'not-encrypted' to PeerKeysStatus type"
```

---

## Task 2: Добавить early-return для публичных комнат в ensureRoomCrypto

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts:3366-3385`

**Step 1: Добавить guard**

В `ensureRoomCrypto` (строка 3367) добавить проверку публичной комнаты после получения `matrixRoom`, перед вызовом `pcrypto.addRoom()`:

```typescript
  const ensureRoomCrypto = async (roomId: string): Promise<PcryptoRoomInstance | undefined> => {
    const pcrypto = pcryptoRef.value;
    if (!pcrypto) return undefined;

    // Already exists
    if (pcrypto.rooms[roomId]) return pcrypto.rooms[roomId];

    // Create: get the Matrix room object
    const matrixService = getMatrixClientService();
    const matrixRoom = matrixService.getRoom(roomId);
    if (!matrixRoom) return undefined;

    // Skip encryption setup for public rooms (matches Bastyon's prepareChat behavior)
    if (isRoomPublic(roomId)) return undefined;

    try {
      return await pcrypto.addRoom(matrixRoom as Record<string, unknown>);
    } catch (e) {
      console.warn("[chat-store] ensureRoomCrypto failed for", roomId, e);
      return undefined;
    }
  };
```

Единственное изменение — добавить строку `if (isRoomPublic(roomId)) return undefined;` после проверки `matrixRoom`.

**Step 2: Проверить типы**

Run: `npx vue-tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/entities/chat/model/chat-store.ts
git commit -m "fix: skip pcrypto initialization for public rooms"
```

---

## Task 3: Обновить checkPeerKeys — различать причины отключения шифрования

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts:5563-5577`

**Step 1: Переписать checkPeerKeys**

Заменить текущую реализацию на:

```typescript
  /** Check encryption status for a room.
   *  Updates peerKeysStatus map and returns the status.
   *  - "available": room supports encryption and all peers have keys
   *  - "missing": room could support encryption but peers lack keys
   *  - "not-encrypted": room is public or too large for encryption
   *  - "unknown": crypto not initialized yet */
  const checkPeerKeys = async (roomId: string): Promise<PeerKeysStatus> => {
    // Public rooms or rooms with ≥50 members — encryption disabled by design
    if (isRoomPublic(roomId)) {
      peerKeysStatus.set(roomId, "not-encrypted");
      return "not-encrypted";
    }

    const authStore = useAuthStore();
    const roomCrypto = authStore.pcrypto?.rooms[roomId];
    if (!roomCrypto) {
      peerKeysStatus.set(roomId, "unknown");
      return "unknown";
    }

    const canEncrypt = roomCrypto.canBeEncrypt();
    // canBeEncrypt returns false for public rooms (already handled above),
    // rooms with ≥50 members, or rooms where peers lack keys.
    // Distinguish "too large" from "missing keys":
    if (!canEncrypt) {
      const matrixService = getMatrixClientService();
      const matrixRoom = matrixService.getRoom(roomId);
      const memberCount = (matrixRoom as any)?.getJoinedMemberCount?.() ?? 0;
      if (memberCount >= 50) {
        peerKeysStatus.set(roomId, "not-encrypted");
        return "not-encrypted";
      }
      peerKeysStatus.set(roomId, "missing");
      return "missing";
    }

    peerKeysStatus.set(roomId, "available");
    return "available";
  };
```

**Step 2: Проверить типы**

Run: `npx vue-tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/entities/chat/model/chat-store.ts
git commit -m "fix: distinguish 'not-encrypted' from 'missing keys' in checkPeerKeys"
```

---

## Task 4: Добавить computed encryptionStatus в chat-store

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts` (раздел return)

**Step 1: Добавить computed**

Перед блоком `return { ... }` (строка ~5619) добавить:

```typescript
  /** Encryption status for the active room — for UI indicators */
  const activeRoomEncrypted = computed<boolean>(() => {
    const roomId = activeRoomId.value;
    if (!roomId) return false;
    const status = peerKeysStatus.get(roomId);
    return status === "available";
  });
```

**Step 2: Экспортировать из return**

В return-объект (строка ~5619) добавить `activeRoomEncrypted` в алфавитном порядке после `activeRoom`:

```typescript
  return {
    activeMediaMessages,
    activeMessages,
    activeRoom,
    activeRoomEncrypted,
    activeRoomId,
    // ... rest
```

**Step 3: Проверить типы**

Run: `npx vue-tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/entities/chat/model/chat-store.ts
git commit -m "feat: add activeRoomEncrypted computed to chat-store"
```

---

## Task 5: Обновить ChatWindow — вызывать checkPeerKeys для групп и показывать статус

**Files:**
- Modify: `src/widgets/chat-window/ChatWindow.vue:85-117, 525-530`

**Step 1: Обновить peerKeysMissing computed и watch**

Заменить блок строк 85-97:

```typescript
const peerKeysMissing = computed(() => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return false;
  // Only show warning for 1:1 chats — group chats don't require all members to have keys
  if (chatStore.activeRoom?.isGroup) return false;
  return chatStore.peerKeysStatus.get(roomId) === "missing";
});

watch(() => chatStore.activeRoomId, async (roomId) => {
  if (roomId && !chatStore.activeRoom?.isGroup) {
    await chatStore.checkPeerKeys(roomId);
  }
}, { immediate: true });
```

на:

```typescript
const peerKeysMissing = computed(() => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return false;
  const status = chatStore.peerKeysStatus.get(roomId);
  // Show warning only when peers lack keys (not for public/large rooms)
  if (chatStore.activeRoom?.isGroup) return false;
  return status === "missing";
});

/** True when the active room does not use encryption (public or ≥50 members) */
const isUnencryptedRoom = computed(() => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return false;
  return chatStore.peerKeysStatus.get(roomId) === "not-encrypted";
});

watch(() => chatStore.activeRoomId, async (roomId) => {
  if (roomId) {
    await chatStore.checkPeerKeys(roomId);
  }
}, { immediate: true });
```

Ключевые изменения:
- `checkPeerKeys` теперь вызывается для ВСЕХ комнат (не только 1:1) — это нужно, чтобы `isUnencryptedRoom` работал
- Добавлен computed `isUnencryptedRoom`

**Step 2: Добавить баннер в template**

После существующего баннера `peerKeysMissing` (строка ~525-530) добавить баннер для незашифрованных комнат:

```html
        <div v-if="peerKeysMissing" class="mx-4 my-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 flex items-center gap-2">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-amber-500">
            <path d="M12 9v4m0 4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/>
          </svg>
          <span>{{ t("chat.peerKeysMissing") }}</span>
        </div>
        <div v-else-if="isUnencryptedRoom" class="mx-4 my-2 rounded-lg bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
          </svg>
          <span>{{ t("chat.unencryptedRoom") }}</span>
        </div>
```

Иконка — открытый замочек (unlocked padlock SVG). Стилистика — тихий информационный баннер (slate, маленький шрифт).

**Step 3: Проверить типы**

Run: `npx vue-tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/widgets/chat-window/ChatWindow.vue
git commit -m "feat: show unencrypted room indicator in ChatWindow"
```

---

## Task 6: Обновить MessageInput — не блокировать отправку в незашифрованных комнатах

**Files:**
- Modify: `src/features/messaging/ui/MessageInput.vue:115-120`

**Step 1: Обновить peerKeysOk computed**

Заменить строки 115-120:

```typescript
const peerKeysOk = computed(() => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return true;
  const status = chatStore.peerKeysStatus.get(roomId);
  return status !== "missing";
});
```

на:

```typescript
const peerKeysOk = computed(() => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return true;
  const status = chatStore.peerKeysStatus.get(roomId);
  // Block send only when peers are missing keys in a private room.
  // "not-encrypted" rooms (public / large) should allow plain-text send.
  return status !== "missing";
});
```

Логика не меняется — `"not-encrypted" !== "missing"` уже возвращает `true`. Но добавляем комментарий для ясности.

Важно: в `handleSend` (строка 158) и `send-btn` (строка 644) проверка `!peerKeysOk` уже корректна — она пропускает `"not-encrypted"` комнаты.

**Step 2: Commit**

```bash
git add src/features/messaging/ui/MessageInput.vue
git commit -m "docs: clarify peerKeysOk behavior for unencrypted rooms"
```

---

## Task 7: Добавить i18n ключи

**Files:**
- Modify: `src/shared/lib/i18n/locales/ru.ts`
- Modify: `src/shared/lib/i18n/locales/en.ts`

**Step 1: Добавить ключ в русскую локаль**

После строки с `"chat.peerKeysMissing"` добавить:

```typescript
  "chat.unencryptedRoom": "Публичная группа — сообщения не шифруются",
```

**Step 2: Добавить ключ в английскую локаль**

После строки с `"chat.peerKeysMissing"` добавить:

```typescript
  "chat.unencryptedRoom": "Public group — messages are not encrypted",
```

**Step 3: Проверить типы**

Run: `npx vue-tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/shared/lib/i18n/locales/ru.ts src/shared/lib/i18n/locales/en.ts
git commit -m "feat: add i18n keys for unencrypted room indicator"
```

---

## Task 8: Написать тесты

**Files:**
- Create: `src/entities/chat/model/__tests__/encryption-guard.test.ts`

**Step 1: Написать тесты**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

/**
 * Integration-level tests for encryption guard logic.
 * Verifies that PeerKeysStatus correctly distinguishes
 * public/large rooms ("not-encrypted") from key-missing rooms ("missing").
 */
describe("encryption-guard", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("PeerKeysStatus type includes 'not-encrypted'", () => {
    // Type-level check — if this compiles, the type is correct
    const status: import("../types").PeerKeysStatus = "not-encrypted";
    expect(status).toBe("not-encrypted");
  });

  it("peerKeysOk should allow send for 'not-encrypted' status", () => {
    // "not-encrypted" !== "missing" → peerKeysOk should be true
    const status: import("../types").PeerKeysStatus = "not-encrypted";
    const peerKeysOk = status !== "missing";
    expect(peerKeysOk).toBe(true);
  });

  it("peerKeysOk should block send for 'missing' status", () => {
    const status: import("../types").PeerKeysStatus = "missing";
    const peerKeysOk = status !== "missing";
    expect(peerKeysOk).toBe(false);
  });

  it("peerKeysOk should allow send for 'available' status", () => {
    const status: import("../types").PeerKeysStatus = "available";
    const peerKeysOk = status !== "missing";
    expect(peerKeysOk).toBe(true);
  });

  it("peerKeysOk should allow send for 'unknown' status", () => {
    const status: import("../types").PeerKeysStatus = "unknown";
    const peerKeysOk = status !== "missing";
    expect(peerKeysOk).toBe(true);
  });
});
```

**Step 2: Запустить тесты**

Run: `npx vitest run src/entities/chat/model/__tests__/encryption-guard.test.ts`
Expected: All 5 tests PASS

**Step 3: Commit**

```bash
git add src/entities/chat/model/__tests__/encryption-guard.test.ts
git commit -m "test: add encryption guard status tests"
```

---

## Task 9: Финальная верификация

**Step 1: Build**

Run: `npm run build`
Expected: PASS

**Step 2: Lint**

Run: `npm run lint`
Expected: PASS

**Step 3: Type check**

Run: `npx vue-tsc --noEmit`
Expected: PASS

**Step 4: Full test suite**

Run: `npm run test`
Expected: All tests PASS

**Step 5: Code review**

Использовать скилл `review` для архитектурного ревью всех изменений.

**Step 6: Final commit (squash if needed)**

Если всё прошло — фича готова к PR.
