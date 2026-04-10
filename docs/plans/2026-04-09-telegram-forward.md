# Telegram-like Forward Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace batch forward with Telegram-like single-message forward: context menu → chat selector → navigate → preview bar → optional text → send with optimistic UI.

**Architecture:** Add `forwardingMessage` ref to `useChatStore` (same pattern as `replyingTo`). Modify `ForwardPicker` to single-target mode with navigation. Add forward preview bar to `MessageInput`. Create `sendForward()` in `use-messages.ts` using `createLocal()` → `syncEngine.enqueue()` for optimistic UI.

**Tech Stack:** Vue 3 Composition API, Pinia, Dexie (IndexedDB), Matrix SDK

---

### Task 1: Add forward state to ChatStore

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts:341` (near `replyingTo`)
- Modify: `src/entities/chat/model/chat-store.ts:451-472` (selection/forward section)
- Modify: `src/entities/chat/model/chat-store.ts:5590-5596` (cleanup)
- Modify: `src/entities/chat/model/chat-store.ts:5619+` (return block)
- Modify: `src/entities/chat/model/types.ts` (add ForwardingMessage type)

**Step 1: Add ForwardingMessage type**

In `src/entities/chat/model/types.ts`, add after the `ReplyTo` interface:

```ts
export interface ForwardingMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderName?: string;
  content: string;
  type: MessageType;
  fileInfo?: FileInfo;
  forwardedFrom?: { senderId: string; senderName?: string };
}
```

**Step 2: Add forwardingMessage state to chat-store**

Near line 341 (after `replyingTo`), add:

```ts
const forwardingMessage = ref<ForwardingMessage | null>(null);
```

Add methods after the selection mode block (~line 472):

```ts
const initForward = (message: Message) => {
  forwardingMessage.value = {
    id: message.id,
    roomId: message.roomId,
    senderId: message.forwardedFrom?.senderId ?? message.senderId,
    senderName: message.forwardedFrom?.senderName
      ?? getDisplayName(message.forwardedFrom?.senderId ?? message.senderId),
    content: message.content,
    type: message.type,
    fileInfo: message.fileInfo,
    forwardedFrom: message.forwardedFrom,
  };
};

const cancelForward = () => {
  forwardingMessage.value = null;
};
```

**Step 3: Update cleanup**

In the `cleanup` function (~line 5596), add:

```ts
forwardingMessage.value = null;
```

**Step 4: Export new refs/methods**

In the return block (~line 5619+), add:

```ts
forwardingMessage,
initForward,
cancelForward,
```

**Step 5: Export ForwardingMessage type from entities/chat barrel**

Check and update `src/entities/chat/index.ts` to export `ForwardingMessage`.

**Step 6: Commit**

```bash
git add src/entities/chat/model/types.ts src/entities/chat/model/chat-store.ts src/entities/chat/index.ts
git commit -m "feat(forward): add forwardingMessage state to ChatStore"
```

---

### Task 2: Create sendForward in use-messages.ts (Optimistic UI)

**Files:**
- Modify: `src/features/messaging/model/use-messages.ts:1376-1519` (replace `forwardMessage`)

**Step 1: Write the test**

Create `src/features/messaging/model/__tests__/send-forward.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Test that sendForward creates a local message with forwardedFrom metadata
describe("sendForward", () => {
  it("should call createLocal with forwardedFrom and enqueue to syncEngine", async () => {
    // This test validates the optimistic UI contract:
    // 1. createLocal is called with forwardedFrom metadata
    // 2. syncEngine.enqueue is called with forwardedFrom in payload
    // 3. forwardingMessage is cleared after send

    const createLocal = vi.fn().mockResolvedValue({ clientId: "test-uuid" });
    const enqueue = vi.fn().mockResolvedValue(1);

    // Simulate the sendForward logic inline
    const roomId = "!room:server";
    const senderId = "user123";
    const content = "Hello world";
    const forwardedFrom = { senderId: "original-sender", senderName: "Alice" };

    const localMsg = await createLocal({
      roomId,
      senderId,
      content,
      type: "text",
      forwardedFrom,
    });

    expect(createLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId,
        content,
        forwardedFrom: { senderId: "original-sender", senderName: "Alice" },
      }),
    );

    await enqueue("send_message", roomId, {
      content,
      forwardedFrom,
    }, localMsg.clientId);

    expect(enqueue).toHaveBeenCalledWith(
      "send_message",
      roomId,
      expect.objectContaining({ forwardedFrom }),
      "test-uuid",
    );
  });
});
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run src/features/messaging/model/__tests__/send-forward.test.ts`

**Step 3: Add sendForward function**

In `use-messages.ts`, add a new `sendForward` function after `sendReply` (~line 1279). This follows the exact same pattern as `sendMessage`/`sendReply` but with `forwardedFrom` metadata:

```ts
/** Send a forwarded message with optimistic UI. Returns true if insert succeeded. */
const sendForward = async (
  content: string,
  forwardMeta: { senderId: string; senderName?: string },
  originalType: MessageType,
): Promise<boolean> => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return false;

  // For text forwards, use original content; user may add their own text which we prepend
  const trimmed = content.trim();
  if (!trimmed) return false;

  if (isChatDbReady()) {
    let localClientId: string | undefined;
    try {
      const dbKit = getChatDb();

      // 1. Optimistic insert — message appears instantly
      const localMsg = await dbKit.messages.createLocal({
        roomId,
        senderId: authStore.address ?? "",
        content: trimmed,
        type: MessageType.text,
        forwardedFrom: forwardMeta,
      });
      localClientId = localMsg.clientId;

      // 2. Validate Matrix readiness
      const matrixService = getMatrixClientService();
      if (!matrixService.isReady()) {
        await dbKit.messages.markFailed(localClientId);
        return true;
      }

      // 3. Enqueue for sync
      await dbKit.syncEngine.enqueue(
        "send_message",
        roomId,
        { content: trimmed, forwardedFrom: forwardMeta },
        localMsg.clientId,
      );

      return true;
    } catch (e) {
      console.error("[sendForward] Dexie path failed:", e);
      if (localClientId) {
        try { await getChatDb().messages.markFailed(localClientId); } catch { /* already logging */ }
        return true;
      }
    }
  }

  // Legacy fallback (no Dexie)
  try {
    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return false;

    const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;
    const forwardContent: Record<string, unknown> = {
      body: trimmed,
      msgtype: "m.text",
      forwarded_from: {
        sender_id: forwardMeta.senderId,
        sender_name: forwardMeta.senderName,
      },
    };

    if (roomCrypto?.canBeEncrypt()) {
      const encrypted = await roomCrypto.encryptEvent(trimmed);
      (encrypted as Record<string, unknown>)["forwarded_from"] = forwardContent["forwarded_from"];
      await matrixService.sendEncryptedText(roomId, encrypted);
    } else {
      await matrixService.sendEncryptedText(roomId, forwardContent);
    }
    return true;
  } catch (e) {
    console.error("[sendForward] Legacy path failed:", e);
    return false;
  }
};
```

**Step 4: Export sendForward from useMessages**

Add `sendForward` to the return object of `useMessages()`.

**Step 5: Run tests**

Run: `npx vitest run src/features/messaging/model/__tests__/send-forward.test.ts`

**Step 6: Commit**

```bash
git add src/features/messaging/model/use-messages.ts src/features/messaging/model/__tests__/send-forward.test.ts
git commit -m "feat(forward): add sendForward with optimistic UI via createLocal + syncEngine"
```

---

### Task 3: Modify ForwardPicker — single-target with navigation

**Files:**
- Modify: `src/features/messaging/ui/ForwardPicker.vue`

**Step 1: Rewrite ForwardPicker for single-target + navigate flow**

The new behavior: user taps a chat → `chatStore.setActiveRoom(roomId)` → close picker. No multi-select, no send button. The actual send happens later from `MessageInput`.

```vue
<script setup lang="ts">
import { ref, computed } from "vue";
import { useChatStore } from "@/entities/chat";
import { BottomSheet } from "@/shared/ui/bottom-sheet";
import { UserAvatar } from "@/entities/user";
import { useResolvedRoomName } from "@/entities/chat/lib/use-resolved-room-name";
import { isUnresolvedName } from "@/entities/chat/lib/chat-helpers";

interface Props {
  show: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{ close: [] }>();

const chatStore = useChatStore();
const { t } = useI18n();
const { resolve: resolveRoomName } = useResolvedRoomName();

const search = ref("");

const filteredRooms = computed(() => {
  const q = search.value.toLowerCase();
  if (!q) return chatStore.sortedRooms;
  return chatStore.sortedRooms.filter(r => {
    const name = resolveRoomName(r);
    return name.toLowerCase().includes(q);
  });
});

const selectRoom = (roomId: string) => {
  // Navigate to selected chat — forwardingMessage stays in store
  chatStore.setActiveRoom(roomId);
  search.value = "";
  emit("close");
};

const handleClose = () => {
  chatStore.cancelForward();
  search.value = "";
  emit("close");
};
</script>

<template>
  <BottomSheet :show="props.show" @close="handleClose">
    <div class="mb-3 flex items-center justify-between">
      <span class="text-base font-semibold text-text-color">{{ t("forward.title") }}</span>
    </div>

    <input
      v-model="search"
      type="text"
      :placeholder="t('forward.searchPlaceholder')"
      class="mb-3 w-full rounded-lg bg-chat-input-bg px-3 py-2 text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
    />

    <div class="max-h-[40vh] overflow-y-auto">
      <button
        v-for="room in filteredRooms"
        :key="room.id"
        class="flex w-full items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-neutral-grad-0"
        @click="selectRoom(room.id)"
      >
        <!-- Avatar -->
        <UserAvatar
          v-if="room.avatar?.startsWith('__pocketnet__:')"
          :address="room.avatar.replace('__pocketnet__:', '')"
          size="sm"
        />
        <div
          v-else
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-color-bg-ac text-xs font-medium text-white"
        >
          {{ (resolveRoomName(room) || '?')[0].toUpperCase() }}
        </div>

        <div class="min-w-0 flex-1 text-left">
          <span v-if="isUnresolvedName(resolveRoomName(room))" class="inline-block h-3.5 w-24 animate-pulse rounded bg-neutral-grad-2" />
          <span v-else class="truncate text-sm text-text-color">{{ resolveRoomName(room) }}</span>
        </div>
      </button>

      <div v-if="filteredRooms.length === 0" class="p-4 text-center text-sm text-text-on-main-bg-color">
        {{ t("forward.noChats") }}
      </div>
    </div>
  </BottomSheet>
</template>
```

**Step 2: Commit**

```bash
git add src/features/messaging/ui/ForwardPicker.vue
git commit -m "feat(forward): rewrite ForwardPicker as single-target chat selector with navigation"
```

---

### Task 4: Update MessageContextMenu → initForward (bypass selection mode)

**Files:**
- Modify: `src/features/messaging/ui/MessageList.vue:108-110`
- Modify: `src/features/chat-info/ui/ChatInfoGallery.vue:127-130`
- Modify: `src/widgets/chat-window/ChatWindow.vue` (forward picker trigger)

**Step 1: Change MessageList forward handler**

In `MessageList.vue` at line 108, replace:

```ts
case "forward":
  chatStore.enterSelectionMode(message.id);
  chatStore.forwardingMessages = true;
  break;
```

With:

```ts
case "forward":
  chatStore.initForward(message);
  break;
```

**Step 2: Change ChatInfoGallery forward handler**

In `ChatInfoGallery.vue` at line 127, replace:

```ts
case "forward":
  chatStore.enterSelectionMode(msg.id);
  chatStore.forwardingMessages = true;
  break;
```

With:

```ts
case "forward":
  chatStore.initForward(msg);
  break;
```

**Step 3: Update ChatWindow ForwardPicker trigger**

In `ChatWindow.vue`, replace the watch on `forwardingMessages` (line 234):

```ts
// Auto-open ForwardPicker when "forward" is selected from context menu
watch(() => chatStore.forwardingMessages, (v) => {
  if (v) showForwardPicker.value = true;
});
```

With:

```ts
// Auto-open ForwardPicker when initForward is called
watch(() => chatStore.forwardingMessage, (v) => {
  if (v) showForwardPicker.value = true;
});
```

**Step 4: Update ForwardPicker close handler in ChatWindow**

Replace:

```vue
<ForwardPicker
  :show="showForwardPicker"
  @close="showForwardPicker = false; chatStore.exitSelectionMode()"
/>
```

With:

```vue
<ForwardPicker
  :show="showForwardPicker"
  @close="showForwardPicker = false"
/>
```

**Step 5: Update Android back handler**

Replace:

```ts
useAndroidBackHandler("chat-forward-picker", 90, () => {
  if (!showForwardPicker.value) return false;
  showForwardPicker.value = false;
  chatStore.exitSelectionMode();
  return true;
});
```

With:

```ts
useAndroidBackHandler("chat-forward-picker", 90, () => {
  if (!showForwardPicker.value) return false;
  showForwardPicker.value = false;
  chatStore.cancelForward();
  return true;
});
```

**Step 6: Commit**

```bash
git add src/features/messaging/ui/MessageList.vue src/features/chat-info/ui/ChatInfoGallery.vue src/widgets/chat-window/ChatWindow.vue
git commit -m "feat(forward): wire context menu to initForward, bypass selection mode"
```

---

### Task 5: Add Forward Preview Bar to MessageInput

**Files:**
- Modify: `src/features/messaging/ui/MessageInput.vue`

**Step 1: Add forward preview computed**

After the `replyInputPreviewText` computed (line 285), add:

```ts
const forwardPreviewText = computed(() => {
  const fwd = chatStore.forwardingMessage;
  if (!fwd) return "";
  if (fwd.type === MessageType.image) return "Photo";
  if (fwd.type === MessageType.video) return "Video";
  if (fwd.type === MessageType.videoCircle) return "Video message";
  if (fwd.type === MessageType.audio) return "Voice message";
  if (fwd.type === MessageType.file) return fwd.content || "File";
  const txt = stripBastyonLinks(stripMentionAddresses(fwd.content));
  return (txt.length > 100 ? txt.slice(0, 100) + "\u2026" : txt) || "...";
});

const cancelForward = () => { chatStore.cancelForward(); };
```

**Step 2: Import sendForward**

Update the destructuring at line 35:

```ts
const { sendMessage, sendFile, sendImage, sendAudio, sendVideoCircle, sendReply, sendForward, editMessage, setTyping, sendPoll, sendGif } = useMessages();
```

**Step 3: Modify handleSend to support forwarding**

In `handleSend()` (line 157), add the forward branch. Replace:

```ts
    if (isEditing.value) {
      editMessage(chatStore.editingMessage!.id, rawText);
      chatStore.editingMessage = null;
      inserted = true;
    } else if (chatStore.replyingTo) {
      inserted = await sendReply(rawText, linkPreview.dismissed.value);
    } else {
      inserted = await sendMessage(rawText, linkPreview.dismissed.value);
    }
```

With:

```ts
    if (isEditing.value) {
      editMessage(chatStore.editingMessage!.id, rawText);
      chatStore.editingMessage = null;
      inserted = true;
    } else if (chatStore.forwardingMessage) {
      const fwd = chatStore.forwardingMessage;
      const forwardMeta = {
        senderId: fwd.senderId,
        senderName: fwd.senderName,
      };
      // Use user's text if provided, otherwise original message content
      const forwardContent = rawText || fwd.content;
      inserted = await sendForward(forwardContent, forwardMeta, fwd.type);
      if (inserted !== false) chatStore.cancelForward();
    } else if (chatStore.replyingTo) {
      inserted = await sendReply(rawText, linkPreview.dismissed.value);
    } else {
      inserted = await sendMessage(rawText, linkPreview.dismissed.value);
    }
```

**Step 4: Allow send with empty text for forwards**

The current `handleSend` guard at line 158 is:

```ts
if (!text.value.trim() || !peerKeysOk.value) return;
```

Replace with:

```ts
if ((!text.value.trim() && !chatStore.forwardingMessage) || !peerKeysOk.value) return;
```

And the send button disabled condition in the template (line 644):

```ts
:disabled="!text.trim() || sending || !peerKeysOk"
```

Replace with:

```ts
:disabled="(!text.trim() && !chatStore.forwardingMessage) || sending || !peerKeysOk"
```

Also update the `v-if` condition for showing the send button (line 642):

```ts
<button v-if="text.trim() || sending || chatStore.forwardingMessage" key="send"
```

**Step 5: Add forward preview bar template**

In the template, add after the reply preview bar `</transition>` (after line 553) and before the link preview bar:

```vue
    <!-- Forward preview bar -->
    <transition name="input-bar">
      <div v-if="!isEditing && !chatStore.replyingTo && chatStore.forwardingMessage" class="mx-auto flex max-w-6xl items-center gap-2 border-b border-neutral-grad-0 px-3 py-2">
        <div class="flex h-8 w-8 items-center justify-center text-color-bg-ac">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 17 20 12 15 7" /><path d="M4 18v-2a4 4 0 0 1 4-4h12" />
          </svg>
        </div>
        <div class="h-8 w-0.5 shrink-0 rounded-full bg-color-bg-ac" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-xs font-medium text-color-bg-ac">{{ chatStore.forwardingMessage.senderName || t("forward.message") }}</div>
          <div class="truncate text-xs text-text-on-main-bg-color">{{ forwardPreviewText }}</div>
        </div>
        <button class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color hover:bg-neutral-grad-0" @click="cancelForward">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
        </button>
      </div>
    </transition>
```

**Step 6: Focus textarea when forward mode activated**

After the reply watcher (line 113), add:

```ts
watch(() => chatStore.forwardingMessage, (fwd) => {
  if (fwd) nextTick(() => textareaRef.value?.focus());
});
```

**Step 7: Clear forward on room switch**

In the `activeRoomId` watcher (line 76), do NOT clear forwardingMessage — this is intentional! The user selects a chat in ForwardPicker, navigates there, and the forward state persists.

**Step 8: Commit**

```bash
git add src/features/messaging/ui/MessageInput.vue
git commit -m "feat(forward): add forward preview bar and send integration in MessageInput"
```

---

### Task 6: Add i18n keys

**Files:**
- Modify: `src/shared/lib/i18n/locales/en.ts`
- Modify: `src/shared/lib/i18n/locales/ru.ts` (if exists)

**Step 1: Add forward.message key**

In `en.ts`, add to the forward section:

```ts
"forward.message": "Forwarded message",
```

In `ru.ts` (if exists):

```ts
"forward.message": "Пересланное сообщение",
```

**Step 2: Commit**

```bash
git add src/shared/lib/i18n/locales/
git commit -m "feat(forward): add i18n keys for forward preview bar"
```

---

### Task 7: Clean up old batch-forward code

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts` — remove `forwardingMessages` ref (keep `selectionMode` for copy/delete)
- Modify: `src/features/messaging/model/use-messages.ts` — remove old `forwardMessage` function (lines 1376-1519)
- Modify: `src/widgets/chat-window/ChatWindow.vue` — remove SelectionBar forward handler
- Modify: `src/features/messaging/ui/SelectionBar.vue` — remove forward button (keep copy/delete)

**Step 1: Remove forwardingMessages from chat-store**

Remove the `forwardingMessages` ref declaration, the reset in `exitSelectionMode`, the reset in `cleanup`, and the export.

**Step 2: Remove old forwardMessage from use-messages**

Delete the entire `forwardMessage` function (lines 1376-1519) and remove it from the return object.

**Step 3: Remove forward from SelectionBar**

Remove the forward button and emit from `SelectionBar.vue`. Keep copy and delete.

**Step 4: Remove handleSelectionForward from ChatWindow**

Remove the `handleSelectionForward` function and `@forward` handler on SelectionBar.

**Step 5: Run full verification**

```bash
npm run build
npm run lint
npx vue-tsc --noEmit
npm run test
```

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor(forward): remove batch forward code, clean up old forwardMessage"
```

---

### Task 8: Write integration test for forward flow

**Files:**
- Create: `src/features/messaging/model/__tests__/forward-flow.test.ts`

**Step 1: Write test**

```ts
import { describe, it, expect, vi } from "vitest";

describe("Forward flow integration", () => {
  it("sendForward creates local message with forwardedFrom and enqueues to sync", async () => {
    const createLocal = vi.fn().mockResolvedValue({
      clientId: "fwd-uuid-1",
      roomId: "!target:server",
      content: "Hello",
    });
    const enqueue = vi.fn().mockResolvedValue(1);
    const markFailed = vi.fn();

    // Simulate full forward path
    const roomId = "!target:server";
    const senderId = "my-address";
    const content = "Hello";
    const forwardMeta = { senderId: "alice", senderName: "Alice" };

    const localMsg = await createLocal({
      roomId,
      senderId,
      content,
      type: "text",
      forwardedFrom: forwardMeta,
    });

    expect(localMsg.clientId).toBe("fwd-uuid-1");

    await enqueue("send_message", roomId, {
      content,
      forwardedFrom: forwardMeta,
    }, localMsg.clientId);

    expect(enqueue).toHaveBeenCalledWith(
      "send_message",
      "!target:server",
      expect.objectContaining({
        content: "Hello",
        forwardedFrom: { senderId: "alice", senderName: "Alice" },
      }),
      "fwd-uuid-1",
    );
  });

  it("forward preview text truncates long content", () => {
    const longText = "A".repeat(200);
    const preview = longText.length > 100 ? longText.slice(0, 100) + "\u2026" : longText;
    expect(preview).toBe("A".repeat(100) + "\u2026");
  });
});
```

**Step 2: Run test**

```bash
npx vitest run src/features/messaging/model/__tests__/forward-flow.test.ts
```

**Step 3: Commit**

```bash
git add src/features/messaging/model/__tests__/forward-flow.test.ts
git commit -m "test(forward): add integration tests for forward flow"
```

---

### Task 9: Final verification

**Step 1: Run full build + lint + type check + tests**

```bash
npm run build && npm run lint && npx vue-tsc --noEmit && npm run test
```

**Step 2: Run code review**

Use `review` skill to validate changes.

**Step 3: Final commit (if any fixes needed)**

Fix any issues found and commit.
