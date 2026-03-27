# Unified Encrypted/Unresolved Display — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Never show raw encrypted strings or truncated hex addresses in the UI — show skeletons while resolving, human-readable fallbacks when failed.

**Architecture:** Introduce `DisplayResult` type (`resolving | ready | failed`) and three formatter functions that wrap existing resolution logic. Components consume `state` to pick skeleton/text/fallback. Data pipeline extended to propagate `decryptionStatus` from Dexie to UI.

**Tech Stack:** Vue 3 Composition API, TypeScript, Pinia, Dexie (IndexedDB), vue-i18n

**Design doc:** `docs/plans/2026-03-25-encrypted-display-design.md`

---

### Task 1: Add i18n keys

**Files:**
- Modify: `src/shared/lib/i18n/locales/en.ts`
- Modify: `src/shared/lib/i18n/locales/ru.ts`

**Step 1: Add keys to English locale**

Add after `"common.cancel": "Cancel"`:
```typescript
"common.unknownUser": "User",
"common.encryptedChat": "Chat",
"message.notDecrypted": "Message not decrypted",
```

**Step 2: Add keys to Russian locale**

Add after `"common.cancel": "Отмена"`:
```typescript
"common.unknownUser": "Пользователь",
"common.encryptedChat": "Чат",
"message.notDecrypted": "Сообщение не расшифровано",
```

**Step 3: Commit**

```bash
git add src/shared/lib/i18n/locales/en.ts src/shared/lib/i18n/locales/ru.ts
git commit -m "feat: add i18n keys for encrypted display fallbacks"
```

---

### Task 2: Create `DisplayResult` type and formatter functions

**Files:**
- Create: `src/entities/chat/lib/display-result.ts`
- Test: `src/entities/chat/lib/display-result.test.ts`

**Step 1: Write failing tests**

```typescript
// src/entities/chat/lib/display-result.test.ts
import { describe, it, expect } from "vitest";
import {
  type DisplayResult,
  getRoomTitleForUI,
  getUserDisplayNameForUI,
  getMessagePreviewForUI,
} from "./display-result";

describe("getRoomTitleForUI", () => {
  it("returns ready when name is human-readable", () => {
    const result = getRoomTitleForUI("My Chat Room", { gaveUp: false, roomId: "!abc:s" });
    expect(result).toEqual({ state: "ready", text: "My Chat Room" });
  });

  it("returns resolving when name is unresolved hex and not gave up", () => {
    const result = getRoomTitleForUI("a1b2c3d4e5f6a1b2c3d4", { gaveUp: false, roomId: "!abc:s" });
    expect(result.state).toBe("resolving");
    expect(result.text).toBe("");
  });

  it("returns failed with fallback when name is unresolved and gave up", () => {
    const result = getRoomTitleForUI("a1b2c3d4e5f6a1b2c3d4", { gaveUp: true, roomId: "!xY9z:s" });
    expect(result.state).toBe("failed");
    expect(result.text).toMatch(/^Чат #/); // fallback with hash suffix
  });

  it("returns ready for names starting with @", () => {
    const result = getRoomTitleForUI("@MyChannel", { gaveUp: false, roomId: "!abc:s" });
    expect(result).toEqual({ state: "ready", text: "@MyChannel" });
  });

  it("returns resolving for truncated hex like a1b2c3d4…ef56", () => {
    const result = getRoomTitleForUI("a1b2c3d4\u2026ef56", { gaveUp: false, roomId: "!abc:s" });
    expect(result.state).toBe("resolving");
  });

  it("returns failed fallback for truncated hex when gave up", () => {
    const result = getRoomTitleForUI("a1b2c3d4\u2026ef56", { gaveUp: true, roomId: "!xY9z:s" });
    expect(result.state).toBe("failed");
  });
});

describe("getUserDisplayNameForUI", () => {
  const fallback = "Пользователь";

  it("returns ready for proper name", () => {
    const result = getUserDisplayNameForUI("John Doe", fallback);
    expect(result).toEqual({ state: "ready", text: "John Doe" });
  });

  it("returns failed for truncated hex address", () => {
    const result = getUserDisplayNameForUI("a1b2c3d4\u2026ef56", fallback);
    expect(result.state).toBe("failed");
    expect(result.text).toBe(fallback);
  });

  it("returns failed for long hex string", () => {
    const result = getUserDisplayNameForUI("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", fallback);
    expect(result.state).toBe("failed");
    expect(result.text).toBe(fallback);
  });

  it("returns ready for short non-hex name", () => {
    const result = getUserDisplayNameForUI("Al", fallback);
    expect(result).toEqual({ state: "ready", text: "Al" });
  });
});

describe("getMessagePreviewForUI", () => {
  const failedText = "Сообщение не расшифровано";

  it("returns ready for normal text", () => {
    const result = getMessagePreviewForUI("Hello world", undefined, failedText);
    expect(result).toEqual({ state: "ready", text: "Hello world" });
  });

  it("returns resolving for [encrypted] with pending status", () => {
    const result = getMessagePreviewForUI("[encrypted]", "pending", failedText);
    expect(result).toEqual({ state: "resolving", text: "" });
  });

  it("returns resolving for [encrypted] with no status", () => {
    const result = getMessagePreviewForUI("[encrypted]", undefined, failedText);
    expect(result).toEqual({ state: "resolving", text: "" });
  });

  it("returns failed for [encrypted] with failed status", () => {
    const result = getMessagePreviewForUI("[encrypted]", "failed", failedText);
    expect(result).toEqual({ state: "failed", text: failedText });
  });

  it("returns failed for m.bad.encrypted with failed status", () => {
    const result = getMessagePreviewForUI("m.bad.encrypted", "failed", failedText);
    expect(result).toEqual({ state: "failed", text: failedText });
  });

  it("returns resolving for Unable to decrypt with pending status", () => {
    const result = getMessagePreviewForUI("** Unable to decrypt **", "pending", failedText);
    expect(result).toEqual({ state: "resolving", text: "" });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/entities/chat/lib/display-result.test.ts`
Expected: FAIL — module not found

**Step 3: Implement `display-result.ts`**

```typescript
// src/entities/chat/lib/display-result.ts
import { isUnresolvedName } from "./chat-helpers";
import { isEncryptedPlaceholder } from "@/shared/lib/utils/is-encrypted-placeholder";

export type DisplayState = "resolving" | "ready" | "failed";

export interface DisplayResult {
  state: DisplayState;
  text: string;
}

/**
 * Determine display state for a room title.
 * @param resolvedName - Result of resolveRoom() or resolveRoomName()
 * @param opts.gaveUp - Whether name resolution has permanently failed for this room
 * @param opts.roomId - Matrix room ID, used to generate unique fallback suffix
 */
export function getRoomTitleForUI(
  resolvedName: string,
  opts: { gaveUp: boolean; roomId: string },
): DisplayResult {
  if (!isUnresolvedName(resolvedName)) {
    return { state: "ready", text: resolvedName };
  }
  if (opts.gaveUp) {
    // Generate a short unique suffix from the room ID (skip the leading "!")
    const suffix = opts.roomId.slice(1, 5).toUpperCase();
    return { state: "failed", text: `Чат #${suffix}` };
  }
  return { state: "resolving", text: "" };
}

/**
 * Determine display state for a user display name.
 * No "resolving" state — getDisplayName is synchronous with full fallback chain.
 * @param resolvedName - Result of chatStore.getDisplayName()
 * @param fallbackText - i18n translated fallback, e.g. t('common.unknownUser')
 */
export function getUserDisplayNameForUI(
  resolvedName: string,
  fallbackText: string,
): DisplayResult {
  if (isUnresolvedName(resolvedName)) {
    return { state: "failed", text: fallbackText };
  }
  return { state: "ready", text: resolvedName };
}

/**
 * Determine display state for a message preview in chat list.
 * @param content - Message content string (may be encrypted placeholder)
 * @param decryptionStatus - From LocalRoom/Message: undefined | "pending" | "failed"
 * @param failedText - i18n translated fallback, e.g. t('message.notDecrypted')
 */
export function getMessagePreviewForUI(
  content: string | undefined | null,
  decryptionStatus: string | undefined | null,
  failedText: string,
): DisplayResult {
  if (isEncryptedPlaceholder(content)) {
    if (decryptionStatus === "failed") {
      return { state: "failed", text: failedText };
    }
    return { state: "resolving", text: "" };
  }
  return { state: "ready", text: content ?? "" };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/entities/chat/lib/display-result.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/entities/chat/lib/display-result.ts src/entities/chat/lib/display-result.test.ts
git commit -m "feat: add DisplayResult type and formatter functions for encrypted/unresolved data"
```

---

### Task 3: Add `decryptionStatus` to `Message` type and propagate in mapper

**Files:**
- Modify: `src/entities/chat/model/types.ts:70-112` — add field to Message interface
- Modify: `src/shared/lib/local-db/mappers.ts:19-46` — propagate in localToMessage

**Step 1: Add `decryptionStatus` to Message interface**

In `src/entities/chat/model/types.ts`, after `uploadProgress?: number;` (line 102), add:

```typescript
  /** Decryption status — only set for encrypted messages (absence = ok/not encrypted) */
  decryptionStatus?: "pending" | "failed";
```

**Step 2: Propagate in `localToMessage` mapper**

In `src/shared/lib/local-db/mappers.ts`, in the return object (after line 45 `uploadProgress: local.uploadProgress,`), add:

```typescript
    // Only propagate non-ok statuses to avoid polluting 99% of messages
    decryptionStatus: (local.decryptionStatus === "pending" || local.decryptionStatus === "failed")
      ? local.decryptionStatus : undefined,
```

**Step 3: Run typecheck**

Run: `npx vue-tsc --noEmit`
Expected: PASS (no new errors)

**Step 4: Commit**

```bash
git add src/entities/chat/model/types.ts src/shared/lib/local-db/mappers.ts
git commit -m "feat: propagate decryptionStatus from LocalMessage to Message UI type"
```

---

### Task 4: Add `lastMessageDecryptionStatus` to LocalRoom and propagate to ChatRoom

**Files:**
- Modify: `src/shared/lib/local-db/schema.ts:58-70` — add field to LocalRoom
- Modify: `src/shared/lib/local-db/room-repository.ts` — propagate in updateLastMessage
- Modify: `src/shared/lib/local-db/event-writer.ts` — set status when writing preview
- Modify: `src/shared/lib/local-db/decryption-worker.ts:143-154` — update room preview on dead letter
- Modify: `src/entities/chat/model/chat-store.ts:725-749` — propagate to ChatRoom.lastMessage
- Modify: `src/entities/chat/model/types.ts` — add field to ChatRoom

**Step 1: Add field to LocalRoom schema**

In `src/shared/lib/local-db/schema.ts`, after `lastMessageLocalStatus?: LocalMessageStatus;` (line 70), add:

```typescript
  /** Decryption status of last message preview: undefined = ok, "pending" = waiting, "failed" = permanent */
  lastMessageDecryptionStatus?: "pending" | "failed";
```

**Step 2: Propagate in room-repository**

In `src/shared/lib/local-db/room-repository.ts`, find the `updateLastMessage` method. In its `changes` object (around line 233-237), add:

```typescript
      lastMessageDecryptionStatus: undefined, // Cleared on successful preview update
```

Also add `lastMessageDecryptionStatus` to the `upsertRooms` method's insert defaults (around line 192).

**Step 3: Set status in event-writer**

In `src/shared/lib/local-db/event-writer.ts`, where room preview is updated after writing messages, if the preview text is an encrypted placeholder, set:

```typescript
lastMessageDecryptionStatus: "pending",
```

Otherwise set it to `undefined`.

**Step 4: Update room preview on dead letter in decryption-worker**

In `src/shared/lib/local-db/decryption-worker.ts`, after the dead-letter block (line 144-152), add room preview update:

```typescript
// Also update room preview status to "failed" so UI shows fallback instead of infinite skeleton
if (isDead) {
  // ... existing message update ...
  try {
    const room = await this.db.rooms.get(job.roomId);
    if (room && room.lastMessageEventId === eventId) {
      await this.db.rooms.update(job.roomId, {
        lastMessageDecryptionStatus: "failed",
      });
    }
  } catch { /* non-critical */ }
}
```

**Step 5: Propagate to ChatRoom in chat-store.ts**

In `src/entities/chat/model/chat-store.ts`, in the `sortedRooms` computed (lines 735-747), add `decryptionStatus` to the `lastMessage` object:

```typescript
lastMessage: effectivePreview != null ? {
  id: "",
  roomId: lr.id,
  senderId: lr.lastMessageSenderId ?? "",
  content: effectivePreview,
  timestamp: ts,
  status: deriveOutboundStatus(/*...*/),
  type: lr.lastMessageType ?? MessageType.text,
  decryptionStatus: lr.lastMessageDecryptionStatus, // NEW
} as Message : undefined,
```

Also add `lastMessageDecryptionStatus` to the cache key comparison (around line 712-722) so changes trigger re-render.

**Step 6: Run typecheck + tests**

Run: `npx vue-tsc --noEmit && npx vitest run`
Expected: PASS

**Step 7: Commit**

```bash
git add src/shared/lib/local-db/schema.ts src/shared/lib/local-db/room-repository.ts \
  src/shared/lib/local-db/event-writer.ts src/shared/lib/local-db/decryption-worker.ts \
  src/entities/chat/model/chat-store.ts src/entities/chat/model/types.ts
git commit -m "feat: propagate lastMessageDecryptionStatus through data pipeline"
```

---

### Task 5: Apply formatters in ContactList

**Files:**
- Modify: `src/features/contacts/ui/ContactList.vue`

**Step 1: Import formatters**

Add import at top of `<script setup>`:
```typescript
import { getRoomTitleForUI, getMessagePreviewForUI, getUserDisplayNameForUI } from "@/entities/chat/lib/display-result";
```

**Step 2: Replace room name rendering (lines 528-530)**

Replace the existing `isRoomNameUnresolved` / `resolveRoomName` pattern:

```vue
<!-- Room name with unified display state -->
<template v-if="(() => { const r = getRoomTitleForUI(resolveRoomName(item as ChatRoom), { gaveUp: gaveUpRooms.has((item as ChatRoom).id), roomId: (item as ChatRoom).id }); return r.state === 'resolving' })()">
  <span class="inline-block h-3.5 w-24 animate-pulse rounded bg-neutral-grad-2" />
</template>
```

**Better approach — use a computed helper:**

Add a function in the script section:
```typescript
function getRoomTitle(room: ChatRoom): DisplayResult {
  return getRoomTitleForUI(
    resolveRoomName(room),
    { gaveUp: gaveUpRooms.value.has(room.id), roomId: room.id },
  );
}
```

Then in template, replace lines 528-530:
```vue
<span v-if="getRoomTitle(item as ChatRoom).state === 'resolving'" class="inline-block h-3.5 w-24 animate-pulse rounded bg-neutral-grad-2" />
<span v-else class="flex items-center gap-1 truncate text-[15px] font-medium text-text-color">
  {{ getRoomTitle(item as ChatRoom).text }}
  <!-- pin/mute icons stay the same -->
```

**Step 3: Replace message preview rendering (lines 571-591)**

Add helper:
```typescript
function getPreview(room: ChatRoom): DisplayResult {
  if (!room.lastMessage) return { state: "ready", text: t("contactList.noMessages") };
  return getMessagePreviewForUI(
    room.lastMessage.content,
    room.lastMessage.decryptionStatus,
    t("message.notDecrypted"),
  );
}
```

Replace the encrypted placeholder skeleton block (lines 572-575) AND adjust the else fallback:

```vue
<!-- Encrypted: resolving → skeleton, failed → fallback text -->
<span
  v-else-if="getPreview(item as ChatRoom).state === 'resolving'"
  class="inline-block h-3 w-32 animate-pulse rounded bg-neutral-grad-2"
/>
<span
  v-else-if="getPreview(item as ChatRoom).state === 'failed'"
  class="truncate text-sm italic text-text-on-main-bg-color"
>
  {{ getPreview(item as ChatRoom).text }}
</span>
```

The existing `v-else` branches for call/system/normal messages stay the same — they only fire when `state === 'ready'`.

**Step 4: Replace sender name in preview (format-preview.ts line 80-81)**

In `src/shared/lib/utils/format-preview.ts`, the sender prefix for group chats:

```typescript
// Before:
const senderName = msg.senderId === myAddr ? t("contactList.you") : chatStore.getDisplayName(msg.senderId);

// After:
const rawName = chatStore.getDisplayName(msg.senderId);
const senderDisplay = getUserDisplayNameForUI(rawName, t("common.unknownUser"));
const senderName = msg.senderId === myAddr ? t("contactList.you") : senderDisplay.text;
```

Import `getUserDisplayNameForUI` at the top of `format-preview.ts`.

**Step 5: Run build + tests**

Run: `npm run build && npx vitest run`
Expected: PASS

**Step 6: Commit**

```bash
git add src/features/contacts/ui/ContactList.vue src/shared/lib/utils/format-preview.ts
git commit -m "feat: apply DisplayResult formatters to ContactList and preview"
```

---

### Task 6: Apply formatters in ChatWindow header

**Files:**
- Modify: `src/widgets/chat-window/ChatWindow.vue:101-107,315-318`

**Step 1: Import and use formatter**

Replace `activeRoomNameLoading` computed:

```typescript
import { getRoomTitleForUI, type DisplayResult } from "@/entities/chat/lib/display-result";

const activeRoomTitle = computed<DisplayResult>(() => {
  const room = chatStore.activeRoom;
  if (!room) return { state: "ready", text: "" };
  _ensureActiveMembers(room);
  const resolved = resolveRoomName(room);
  // In chat header, no gaveUp tracking — treat unresolved as resolving
  // (header has its own skeleton, and room name usually resolves fast)
  return getRoomTitleForUI(resolved, { gaveUp: false, roomId: room.id });
});
```

Note: The chat header does NOT have `gaveUpRooms` tracking (that's in ContactList). Two options:
- Always `gaveUp: false` → skeleton stays until resolved (acceptable for header, user is already in the chat)
- Share `gaveUpRooms` via chat store → more complex, low value

Recommend: `gaveUp: false` for header. If name never resolves, skeleton is better than random hash in the header.

**Step 2: Update template (lines 315-318)**

```vue
<div v-if="activeRoomTitle.state === 'resolving'" class="h-4 w-28 animate-pulse rounded bg-neutral-grad-2" />
<div v-else class="truncate text-[15px] font-medium text-text-color">
  {{ activeRoomTitle.text }}
</div>
```

Remove old `activeRoomNameLoading` and `activeRoomName` computeds.

**Step 3: Run build**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/widgets/chat-window/ChatWindow.vue
git commit -m "feat: apply DisplayResult formatter to chat header room name"
```

---

### Task 7: Apply formatter to MessageBubble sender name

**Files:**
- Modify: `src/features/messaging/ui/MessageBubble.vue:686-693,713-720,735-743`

**Step 1: Import and create helper**

```typescript
import { getUserDisplayNameForUI } from "@/entities/chat/lib/display-result";

const senderDisplayResult = computed(() => {
  const raw = chatStore.getDisplayName(props.message.senderId);
  return getUserDisplayNameForUI(raw, t("common.unknownUser"));
});
```

**Step 2: Replace all 3 sender name render points**

Replace `{{ chatStore.getDisplayName(message.senderId) }}` (lines 692, 719, 742) with:

```vue
{{ senderDisplayResult.text }}
```

The styling for `failed` state — add italic class conditionally:

```vue
<div
  v-if="props.isGroup && !props.isOwn && props.isFirstInGroup"
  class="mb-0.5 cursor-pointer text-sm font-semibold"
  :class="{ 'italic opacity-70': senderDisplayResult.state === 'failed' }"
  :style="{ color: senderColor }"
  @click.stop="openUserProfile?.(message.senderId)"
>
  {{ senderDisplayResult.text }}
</div>
```

Apply to all 3 locations (polls, transfers, text messages).

**Step 3: Run build + tests**

Run: `npm run build && npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add src/features/messaging/ui/MessageBubble.vue
git commit -m "feat: apply DisplayResult formatter to message bubble sender names"
```

---

### Task 8: Export from entity barrel and cleanup

**Files:**
- Modify: `src/entities/chat/index.ts` — re-export DisplayResult type and functions
- Modify: `src/entities/chat/lib/display-result.ts` — add JSDoc if needed

**Step 1: Add exports**

In `src/entities/chat/index.ts`, add:
```typescript
export { type DisplayResult, type DisplayState, getRoomTitleForUI, getUserDisplayNameForUI, getMessagePreviewForUI } from "./lib/display-result";
```

**Step 2: Commit**

```bash
git add src/entities/chat/index.ts
git commit -m "chore: export DisplayResult from chat entity barrel"
```

---

### Task 9: Full verification

**Step 1: Build**

Run: `npm run build`
Expected: PASS

**Step 2: Lint**

Run: `npm run lint`
Expected: PASS (fix any issues)

**Step 3: Typecheck**

Run: `npx vue-tsc --noEmit`
Expected: PASS

**Step 4: Tests**

Run: `npm run test`
Expected: ALL PASS including new display-result tests

**Step 5: Code review**

Use `superpowers:code-reviewer` agent to review all changes against the design doc.

**Step 6: Final commit (if any fixes from review)**

---

### Test Checklist (manual verification)

- [ ] Fully decrypted room: name + preview show normally, no skeleton flash
- [ ] Room with unresolved name (no user profile in store): skeleton shows, then resolves
- [ ] Room where name resolution gave up: shows "Чат #XXXX" instead of hex
- [ ] Encrypted message pending decryption: preview shows skeleton in chat list
- [ ] Encrypted message permanently failed: preview shows "Сообщение не расшифровано"
- [ ] Group chat preview: sender name before message, never truncated hex
- [ ] Chat header: skeleton while loading, real name when resolved
- [ ] Message bubble sender: "Пользователь" in italic when unresolved
- [ ] Mobile (Capacitor): same behavior on iOS/Android
- [ ] No `[encrypted]`, `m.bad.encrypted`, or raw hex visible anywhere in UI
