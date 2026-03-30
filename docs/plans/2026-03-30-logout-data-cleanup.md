# Logout Data Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Полная очистка всех данных аккаунта при логауте — Pinia сторы, Dexie DB, localStorage, legacy IndexedDB.

**Architecture:** Каждый стор/модуль получает функцию `cleanup()`. Logout в auth-store вызывает все cleanup'ы. localStorage чистится по префиксам и конкретным ключам. Dexie БД удаляется целиком. Device settings (тема, язык, устройства звонков) сохраняются.

**Tech Stack:** Vue 3, Pinia, Dexie (IndexedDB), localStorage

---

### Task 1: Add `clearAllDrafts()` to drafts module

**Files:**
- Modify: `src/shared/lib/drafts.ts`
- Test: `src/shared/lib/drafts.test.ts`

**Step 1: Write the failing test**

In `src/shared/lib/drafts.test.ts`, add:

```typescript
it("clearAllDrafts removes all draft keys", () => {
  saveDraft("!room1:mx", "hello");
  saveDraft("!room2:mx", "world");
  localStorage.setItem("unrelated-key", "keep");

  clearAllDrafts();

  expect(getDraft("!room1:mx")).toBe("");
  expect(getDraft("!room2:mx")).toBe("");
  expect(localStorage.getItem("unrelated-key")).toBe("keep");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/lib/drafts.test.ts`
Expected: FAIL — `clearAllDrafts` is not exported

**Step 3: Implement `clearAllDrafts`**

In `src/shared/lib/drafts.ts`, add at the end:

```typescript
export function clearAllDrafts() {
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(DRAFT_PREFIX)) toRemove.push(key);
  }
  for (const key of toRemove) localStorage.removeItem(key);
  // Also remove legacy key if somehow still present
  localStorage.removeItem(LEGACY_KEY);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/lib/drafts.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/shared/lib/drafts.ts src/shared/lib/drafts.test.ts
git commit -m "feat: add clearAllDrafts for logout cleanup"
```

---

### Task 2: Add `cleanup()` to chat-store

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts`

**Step 1: Add cleanup function inside the defineStore callback**

Find the return statement of the store and add a `cleanup` function before it. This function resets all mutable state:

```typescript
const cleanup = () => {
  rooms.value = [];
  roomsMap.clear();
  activeRoomId.value = null;
  messages.value = {};
  typing.value = {};
  replyingTo.value = null;
  isDetachedFromLatest.value = false;
  roomsInitialized.value = false;
  namesReady.value = false;
  editingMessage.value = null;
  deletingMessage.value = null;
  userDisplayNames.value = {};
  selectionMode.value = false;
  selectedMessageIds.value = new Set();
  forwardingMessages.value = false;
  pinnedMessages.value = [];
  pinnedMessageIndex.value = 0;
  pinnedRoomIds.value = new Set();
  mutedRoomIds.value = new Set();
  matrixKitRef.value = null;
  pcryptoRef.value = null;
  chatDbKitRef.value = null;
  decryptedPreviewCache.clear();
  changedRoomIds.clear();
  decryptFailedRooms.clear();
  matrixRoomAddresses.clear();
  profilesRequestedForRooms.clear();
  roomFetchStates.clear();
  _sortedRoomsRef.value = [];
  messageWindowSize.value = 50;

  // Clear localStorage account data
  localStorage.removeItem("chat_pinned_rooms");
  localStorage.removeItem("chat_muted_rooms");
};
```

**Step 2: Export cleanup from the store return**

Add `cleanup` to the return object of the store.

**Step 3: Verify build compiles**

Run: `npx vue-tsc --noEmit`
Expected: no errors

**Step 4: Commit**

```bash
git add src/entities/chat/model/chat-store.ts
git commit -m "feat: add cleanup method to chat-store for logout"
```

---

### Task 3: Add `cleanup()` to user-store

**Files:**
- Modify: `src/entities/user/model/user-store.ts`

**Step 1: Add cleanup function inside the defineStore callback**

```typescript
const cleanup = () => {
  users.value = {};
  triggerRef(users);
  if (_triggerTimer) { clearTimeout(_triggerTimer); _triggerTimer = null; }
  if (_cacheTimer) { clearTimeout(_cacheTimer); _cacheTimer = null; }
  localStorage.removeItem(LS_KEY);
};
```

**Step 2: Export cleanup from the store return**

Add `cleanup` to the return object.

**Step 3: Verify build compiles**

Run: `npx vue-tsc --noEmit`
Expected: no errors

**Step 4: Commit**

```bash
git add src/entities/user/model/user-store.ts
git commit -m "feat: add cleanup method to user-store for logout"
```

---

### Task 4: Add `cleanup()` to channel-store

**Files:**
- Modify: `src/entities/channel/model/channel-store.ts`

**Step 1: Add cleanup function inside the defineStore callback**

```typescript
const cleanup = () => {
  channels.value = [];
  activeChannelAddress.value = null;
  posts.value = new Map();
  isLoadingChannels.value = false;
  isLoadingPosts.value = false;
  channelsPage.value = 0;
  hasMoreChannels.value = true;
  postsStartTxid.value = new Map();
  hasMorePosts.value = new Map();
  blockHeight.value = 0;
  channelError.value = null;
  postsError.value = null;
};
```

**Step 2: Export cleanup from the store return**

Add `cleanup` to the return object.

**Step 3: Verify build compiles**

Run: `npx vue-tsc --noEmit`
Expected: no errors

**Step 4: Commit**

```bash
git add src/entities/channel/model/channel-store.ts
git commit -m "feat: add cleanup method to channel-store for logout"
```

---

### Task 5: Add `deleteLegacyCache()` to chat-cache module

**Files:**
- Modify: `src/shared/lib/cache/chat-cache.ts`

**Step 1: Add delete function**

```typescript
/** Delete the entire legacy chat-cache IndexedDB database */
export function deleteLegacyCache(): void {
  // Close any open connection first
  if (dbPromise) {
    dbPromise.then(db => db.close()).catch(() => {});
    dbPromise = null;
  }
  indexedDB.deleteDatabase(DB_NAME);
}
```

**Step 2: Verify build compiles**

Run: `npx vue-tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/shared/lib/cache/chat-cache.ts
git commit -m "feat: add deleteLegacyCache for logout cleanup"
```

---

### Task 6: Add `clearAccountLocalStorage()` helper

**Files:**
- Create: `src/shared/lib/clear-account-storage.ts`

**Step 1: Create the helper**

```typescript
/**
 * Remove all account-specific localStorage keys.
 * Preserves device settings: theme, locale, call device preferences.
 */
export function clearAccountLocalStorage(): void {
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key.startsWith("bastyon-cache-ts:")) toRemove.push(key);
  }
  for (const key of toRemove) localStorage.removeItem(key);
}
```

This handles cache-timestamp keys that are per-room (`bastyon-cache-ts:{roomId}`). Other account-specific keys are cleaned by their respective store `cleanup()` methods and `clearAllDrafts()`/`clearQueue()`.

**Step 2: Verify build compiles**

Run: `npx vue-tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/shared/lib/clear-account-storage.ts
git commit -m "feat: add clearAccountLocalStorage helper"
```

---

### Task 7: Wire everything into `logout()` in auth-store

**Files:**
- Modify: `src/entities/auth/model/stores.ts`

**Step 1: Add imports at top of file**

```typescript
import { deleteChatDb } from "@/shared/lib/local-db";
import { clearAllDrafts } from "@/shared/lib/drafts";
import { clearQueue } from "@/shared/lib/offline-queue";
import { deleteLegacyCache } from "@/shared/lib/cache/chat-cache";
import { clearAccountLocalStorage } from "@/shared/lib/clear-account-storage";
```

**Step 2: Add cleanup calls to the `logout()` function**

Add these lines at the beginning of `logout()`, before the existing cleanup code:

```typescript
// ── Clean up all account data ──

// 1. Reset Pinia stores (in-memory state)
const chatStore = useChatStore();
chatStore.cleanup();

const userStore = useUserStore();
userStore.cleanup();

const callStore = useCallStore();
callStore.clearCall();

const channelStore = useChannelStore();
channelStore.cleanup();

// 2. Delete Dexie local-first database
deleteChatDb().catch(() => {});

// 3. Clear localStorage account data
clearAllDrafts();
clearQueue();
clearAccountLocalStorage();

// 4. Delete legacy IndexedDB cache
deleteLegacyCache();
```

Add the necessary store imports if not already present:

```typescript
import { useChatStore } from "@/entities/chat/model/chat-store";
import { useCallStore } from "@/entities/call/model/call-store";
import { useChannelStore } from "@/entities/channel/model/channel-store";
```

Note: `useUserStore` is likely already imported in the auth store.

**Step 3: Verify build compiles**

Run: `npx vue-tsc --noEmit`
Expected: no errors

**Step 4: Run full test suite**

Run: `npm run test`
Expected: all tests pass

**Step 5: Commit**

```bash
git add src/entities/auth/model/stores.ts
git commit -m "fix: complete data cleanup on logout — wipe stores, Dexie, localStorage, legacy cache"
```

---

### Task 8: Manual verification

**Step 1: Start dev server**

Run: `npm run dev`

**Step 2: Verify cleanup flow**

1. Login with account A
2. Open several chats, write drafts, pin/mute rooms
3. Logout
4. Login with account B
5. Verify: no rooms/messages/drafts from account A visible
6. Check DevTools → Application → IndexedDB: old `bastyon-chat-{addressA}` DB should be deleted
7. Check DevTools → Application → Local Storage: no `bastyon-chat:draft:*`, `chat_pinned_rooms`, `chat_muted_rooms`, `bastyon-chat-users`, `bastyon-cache-ts:*` keys present

**Step 3: Verify device settings persist**

After logout + re-login, verify: theme, language, call device preferences are unchanged.
