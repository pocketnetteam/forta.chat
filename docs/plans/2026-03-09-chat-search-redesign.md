# Chat Search Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Cmd+K quick chat switcher modal + redesign sidebar search with sectioned results (Chats, Contacts, Messages) and match highlighting.

**Architecture:** Two independent search UIs sharing a common search utility (`use-search.ts` + `highlight.ts`). Cmd+K modal is a global component mounted in `App.vue`. Sidebar search replaces the current toggle-based `ContactSearch` with an always-visible input and sectioned results. Client-side message search across cached/decrypted messages in `chat-store.messages`.

**Tech Stack:** Vue 3 Composition API, Pinia, Tailwind CSS, TypeScript

---

### Task 1: Extract highlight utility from MessageContent

**Files:**
- Create: `src/shared/lib/utils/highlight.ts`
- Modify: `src/features/messaging/ui/MessageContent.vue:20-41`

**Step 1: Create the shared highlight utility**

```typescript
// src/shared/lib/utils/highlight.ts
export type TextPart = { text: string; highlight: boolean };

export function splitByQuery(text: string, query: string): TextPart[] {
  if (!query) return [{ text, highlight: false }];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: TextPart[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const idx = lowerText.indexOf(lowerQuery, cursor);
    if (idx === -1) {
      parts.push({ text: text.slice(cursor), highlight: false });
      break;
    }
    if (idx > cursor) {
      parts.push({ text: text.slice(cursor, idx), highlight: false });
    }
    parts.push({ text: text.slice(idx, idx + query.length), highlight: true });
    cursor = idx + query.length;
  }

  return parts;
}
```

**Step 2: Update MessageContent.vue to use the shared utility**

Replace lines 18-41 in `MessageContent.vue`:

```typescript
// Remove the local splitByQuery and TextPart definitions
// Add import:
import { splitByQuery, type TextPart } from "@/shared/lib/utils/highlight";
```

Remove the local `type TextPart` and `const splitByQuery` function. Keep everything else unchanged.

**Step 3: Verify the app still works**

Run: `npm run build` (or `npx vue-tsc --noEmit`)
Expected: No type errors

**Step 4: Commit**

```bash
git add src/shared/lib/utils/highlight.ts src/features/messaging/ui/MessageContent.vue
git commit -m "refactor: extract splitByQuery highlight utility to shared lib"
```

---

### Task 2: Create search composable `use-search.ts`

**Files:**
- Create: `src/features/search/model/use-search.ts`
- Create: `src/features/search/index.ts`

**Step 1: Create the search composable**

```typescript
// src/features/search/model/use-search.ts
import { ref, computed, watch, type Ref } from "vue";
import { useChatStore } from "@/entities/chat";
import type { ChatRoom, Message } from "@/entities/chat";

export interface MessageSearchResult {
  room: ChatRoom;
  message: Message;
}

/**
 * Rank rooms by query relevance.
 * Priority: name starts with query > name contains query.
 * Within same priority: pinned first, then by updatedAt.
 */
function rankRooms(rooms: ChatRoom[], query: string, pinnedIds: Set<string>): ChatRoom[] {
  const q = query.toLowerCase();
  const scored = rooms
    .filter(r => r.name.toLowerCase().includes(q))
    .map(r => {
      let score = 0;
      if (r.name.toLowerCase().startsWith(q)) score += 100;
      if (pinnedIds.has(r.id)) score += 50;
      // Recency: normalize updatedAt to 0-30 range (last 30 days = max score)
      const ageMs = Date.now() - r.updatedAt;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      score += Math.max(0, 30 - ageDays);
      return { room: r, score };
    });
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.room);
}

export function useSearch() {
  const chatStore = useChatStore();
  const query = ref("");
  const isSearching = ref(false);

  // --- Chat results (instant, no debounce) ---
  const chatResults = computed(() => {
    const q = query.value.trim();
    if (!q) return [];
    return rankRooms(chatStore.sortedRooms, q, chatStore.pinnedRoomIds);
  });

  // --- Message results (client-side, across all cached messages) ---
  const messageResults = computed((): MessageSearchResult[] => {
    const q = query.value.trim().toLowerCase();
    if (!q || q.length < 2) return [];
    const results: MessageSearchResult[] = [];
    const rooms = chatStore.sortedRooms;
    const messagesMap = chatStore.messagesMap; // Record<roomId, Message[]>

    for (const room of rooms) {
      const msgs = messagesMap[room.id];
      if (!msgs) continue;
      for (let i = msgs.length - 1; i >= 0 && results.length < 20; i--) {
        const msg = msgs[i];
        if (msg.content && msg.content.toLowerCase().includes(q)) {
          results.push({ room, message: msg });
        }
      }
      if (results.length >= 20) break;
    }

    results.sort((a, b) => b.message.timestamp - a.message.timestamp);
    return results.slice(0, 20);
  });

  const clearSearch = () => {
    query.value = "";
  };

  return {
    query,
    isSearching,
    chatResults,
    messageResults,
    clearSearch,
  };
}
```

**Step 2: Create feature barrel export**

```typescript
// src/features/search/index.ts
export { useSearch } from "./model/use-search";
export type { MessageSearchResult } from "./model/use-search";
```

**Step 3: Expose `messagesMap` from chat-store if not already exposed**

In `src/entities/chat/model/chat-store.ts`, the `messages` shallowRef (`Record<string, Message[]>`) needs to be exposed in the store's return. Check if it's already returned as `messages` or `messagesMap`. If not, add to the store's return:

```typescript
// In the return statement of the store, add:
messagesMap: messages,  // Record<roomId, Message[]> — for cross-room search
```

Also expose `pinnedRoomIds` if not already exposed.

**Step 4: Verify build**

Run: `npx vue-tsc --noEmit`

**Step 5: Commit**

```bash
git add src/features/search/ src/entities/chat/model/chat-store.ts
git commit -m "feat(search): add useSearch composable with ranked chat and message search"
```

---

### Task 3: Create QuickSearchModal (Cmd+K)

**Files:**
- Create: `src/features/search/ui/QuickSearchModal.vue`
- Modify: `src/app/App.vue`

**Step 1: Create the modal component**

```vue
<!-- src/features/search/ui/QuickSearchModal.vue -->
<script setup lang="ts">
import { useChatStore } from "@/entities/chat";
import type { ChatRoom } from "@/entities/chat";
import { UserAvatar } from "@/entities/user";
import Avatar from "@/shared/ui/avatar/Avatar.vue";
import { splitByQuery } from "@/shared/lib/utils/highlight";
import { useSearch } from "../model/use-search";

const emit = defineEmits<{ close: []; selectRoom: [roomId: string] }>();

const chatStore = useChatStore();
const { query, chatResults, clearSearch } = useSearch();
const { t } = useI18n();

const inputRef = ref<HTMLInputElement>();
const selectedIndex = ref(0);

// Recent chats when query is empty
const recentRooms = computed(() => chatStore.sortedRooms.slice(0, 8));

// Active list: filtered or recent
const displayRooms = computed(() =>
  query.value.trim() ? chatResults.value : recentRooms.value
);

// Reset selection when results change
watch(displayRooms, () => {
  selectedIndex.value = 0;
});

// Focus input on mount
onMounted(() => {
  nextTick(() => inputRef.value?.focus());
});

const handleKeydown = (e: KeyboardEvent) => {
  const len = displayRooms.value.length;
  if (!len) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex.value = (selectedIndex.value + 1) % len;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex.value = (selectedIndex.value - 1 + len) % len;
  } else if (e.key === "Enter") {
    e.preventDefault();
    const room = displayRooms.value[selectedIndex.value];
    if (room) selectRoom(room);
  }
};

const selectRoom = (room: ChatRoom) => {
  chatStore.setActiveRoom(room.id);
  clearSearch();
  emit("selectRoom", room.id);
  emit("close");
};

const handleBackdropClick = () => {
  clearSearch();
  emit("close");
};
</script>

<template>
  <Teleport to="body">
    <transition name="modal-fade">
      <div
        class="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
        @click.self="handleBackdropClick"
        @keydown.escape="handleBackdropClick"
      >
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/50" @click="handleBackdropClick" />

        <!-- Modal -->
        <div
          class="relative w-full max-w-[480px] overflow-hidden rounded-xl border border-neutral-grad-0 bg-chat-sidebar shadow-2xl"
          @keydown="handleKeydown"
        >
          <!-- Search input -->
          <div class="flex items-center gap-3 border-b border-neutral-grad-0 px-4 py-3">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-text-on-main-bg-color">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref="inputRef"
              v-model="query"
              :placeholder="t('quickSearch.placeholder')"
              class="min-w-0 flex-1 bg-transparent text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
            />
            <kbd class="hidden rounded bg-neutral-grad-0 px-1.5 py-0.5 text-[10px] text-text-on-main-bg-color sm:inline">ESC</kbd>
          </div>

          <!-- Results -->
          <div class="max-h-[340px] overflow-y-auto py-1">
            <!-- Section label -->
            <div class="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-on-main-bg-color">
              {{ query.trim() ? t('quickSearch.chats') : t('quickSearch.recent') }}
            </div>

            <button
              v-for="(room, i) in displayRooms"
              :key="room.id"
              class="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors"
              :class="i === selectedIndex ? 'bg-neutral-grad-0' : 'hover:bg-neutral-grad-0/50'"
              @click="selectRoom(room)"
              @mouseenter="selectedIndex = i"
            >
              <UserAvatar
                v-if="room.avatar?.startsWith('__pocketnet__:')"
                :address="room.avatar.replace('__pocketnet__:', '')"
                size="sm"
              />
              <Avatar v-else :src="room.avatar" :name="room.name" size="sm" />
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium text-text-color">
                  <template v-if="query.trim()">
                    <template v-for="(part, j) in splitByQuery(room.name, query.trim())" :key="j">
                      <mark v-if="part.highlight" class="rounded-sm bg-color-txt-ac/20 font-semibold text-color-txt-ac">{{ part.text }}</mark>
                      <span v-else>{{ part.text }}</span>
                    </template>
                  </template>
                  <span v-else>{{ room.name }}</span>
                </div>
                <div class="truncate text-xs text-text-on-main-bg-color">
                  {{ room.lastMessage?.content || "" }}
                </div>
              </div>
            </button>

            <!-- No results -->
            <div
              v-if="query.trim() && !displayRooms.length"
              class="px-4 py-6 text-center text-sm text-text-on-main-bg-color"
            >
              {{ t('quickSearch.noResults') }}
            </div>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.modal-fade-enter-active {
  transition: opacity 0.15s ease-out;
}
.modal-fade-enter-active > :last-child {
  transition: transform 0.15s ease-out, opacity 0.15s ease-out;
}
.modal-fade-leave-active {
  transition: opacity 0.1s ease-in;
}
.modal-fade-enter-from {
  opacity: 0;
}
.modal-fade-enter-from > :last-child {
  transform: scale(0.95);
  opacity: 0;
}
.modal-fade-leave-to {
  opacity: 0;
}
</style>
```

**Step 2: Mount modal and register Cmd+K shortcut in App.vue**

Add to `src/app/App.vue`:

In `<script setup>`, add:
```typescript
import QuickSearchModal from "@/features/search/ui/QuickSearchModal.vue";

const showQuickSearch = ref(false);

const handleGlobalKeydown = (e: KeyboardEvent) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    showQuickSearch.value = !showQuickSearch.value;
  }
  if (e.key === "Escape" && showQuickSearch.value) {
    showQuickSearch.value = false;
  }
};

onMounted(() => {
  // ... existing onMounted code ...
  window.addEventListener("keydown", handleGlobalKeydown);
});
onUnmounted(() => {
  // ... existing onUnmounted code ...
  window.removeEventListener("keydown", handleGlobalKeydown);
});
```

In `<template>`, add before `</div>` (root div closing):
```html
<QuickSearchModal
  v-if="showQuickSearch"
  @close="showQuickSearch = false"
  @select-room="showQuickSearch = false"
/>
```

**Step 3: Add i18n keys**

Add to `src/shared/lib/i18n/locales/en.ts`:
```typescript
"quickSearch.placeholder": "Go to chat...",
"quickSearch.recent": "Recent",
"quickSearch.chats": "Chats",
"quickSearch.noResults": "No chats found",
```

Add to `src/shared/lib/i18n/locales/ru.ts`:
```typescript
"quickSearch.placeholder": "Перейти к чату...",
"quickSearch.recent": "Недавние",
"quickSearch.chats": "Чаты",
"quickSearch.noResults": "Чаты не найдены",
```

**Step 4: Verify build and test manually**

Run: `npm run dev`
Test: Press Cmd+K, type a chat name, navigate with arrows, press Enter.

**Step 5: Commit**

```bash
git add src/features/search/ui/QuickSearchModal.vue src/app/App.vue src/shared/lib/i18n/locales/
git commit -m "feat(search): add Cmd+K quick chat switcher modal"
```

---

### Task 4: Redesign sidebar search with sections

**Files:**
- Modify: `src/features/contacts/ui/ContactSearch.vue` (major rewrite)
- Modify: `src/widgets/sidebar/ChatSidebar.vue:119-210`

**Step 1: Replace search toggle with always-visible input in ChatSidebar**

In `ChatSidebar.vue`, replace the search toggle button (lines 152-183) and the collapsible search div (lines 208-210) with an always-visible search input.

Replace the header section (lines 119-210) — keep the header div but:
1. Remove the `searchOpen` ref and toggle button
2. Add a search input always visible below the header
3. When search has query, replace `ContactList` with `ContactSearch` results

The `ContactSearch` component should take a `query` prop instead of managing its own input.

**Step 2: Rewrite ContactSearch with sectioned results**

Rewrite `src/features/contacts/ui/ContactSearch.vue` to:
- Accept `modelValue` prop for query (v-model from parent)
- Display 3 sections: Chats (from `useSearch().chatResults`), Users (from existing `useContacts`), Messages (from `useSearch().messageResults`)
- Each section shows max 5 items with "Show more" button
- Match highlighting using `splitByQuery`
- Emit events: `selectRoom`, `selectMessage` (for scrolling to message)

Key sections in template:
```vue
<!-- Chats section -->
<div v-if="chatResults.length">
  <div class="section-header">{{ t('contactSearch.chats') }}</div>
  <button v-for="room in visibleChats" ...>
    <!-- Avatar + highlighted name + last message + timestamp -->
  </button>
  <button v-if="chatResults.length > 5 && !showAllChats" @click="showAllChats = true">
    {{ t('contactSearch.showMore') }}
  </button>
</div>

<!-- Users section -->
<div v-if="searchResults.length">
  <div class="section-header">{{ t('contactSearch.users') }}</div>
  <!-- existing user results with highlighting -->
</div>

<!-- Messages section -->
<div v-if="messageResults.length">
  <div class="section-header">{{ t('contactSearch.messages') }}</div>
  <button v-for="result in visibleMessages" ...>
    <!-- Chat avatar + chat name + highlighted message snippet + date -->
  </button>
</div>
```

**Step 3: Update ChatSidebar.vue layout**

Replace the collapsible search pattern with:

```vue
<!-- Always-visible search input below header -->
<div class="shrink-0 px-3 pb-2 pt-1">
  <div class="relative">
    <svg class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-on-main-bg-color" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
    <input
      v-model="sidebarSearchQuery"
      :placeholder="t('contactSearch.placeholder')"
      class="w-full rounded-lg bg-chat-input-bg py-2 pl-8 pr-8 text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
    />
    <button
      v-if="sidebarSearchQuery"
      class="absolute right-2 top-1/2 -translate-y-1/2 text-text-on-main-bg-color hover:text-text-color"
      @click="sidebarSearchQuery = ''"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  </div>
</div>

<!-- Show search results OR normal chat list -->
<ContactSearch
  v-if="sidebarSearchQuery.trim()"
  :query="sidebarSearchQuery"
  @room-created="handleRoomCreated"
  @select-message="handleSelectMessage"
/>
<template v-else>
  <FolderTabs v-model="activeFilter" />
  <div class="relative flex-1 overflow-hidden">
    <ContactList ... />
  </div>
</template>
```

Remove the search toggle button and `searchOpen` ref entirely.

**Step 4: Add new i18n keys**

```typescript
// en.ts
"contactSearch.messages": "Messages",
"contactSearch.showMore": "Show more",

// ru.ts
"contactSearch.messages": "Сообщения",
"contactSearch.showMore": "Показать ещё",
```

**Step 5: Handle message selection navigation**

When a message search result is clicked, emit `selectMessage` with `{ roomId, messageId }`. In `ChatSidebar`, handle this by setting the active room and then scrolling to the message (reuse existing `scrollToMessage` mechanism from `ChatSearch`/`ChatWindow`).

**Step 6: Verify build and test manually**

Run: `npm run dev`
Test:
- Search input visible without clicking
- Type a query → see Chats, Users, Messages sections
- Click a message result → navigate to chat and highlight message
- Clear search → return to normal chat list
- "Show more" expands sections

**Step 7: Commit**

```bash
git add src/features/contacts/ui/ContactSearch.vue src/widgets/sidebar/ChatSidebar.vue src/shared/lib/i18n/locales/
git commit -m "feat(search): redesign sidebar search with Chats/Users/Messages sections"
```

---

### Task 5: Polish and edge cases

**Files:**
- Modify: `src/features/search/ui/QuickSearchModal.vue`
- Modify: `src/features/contacts/ui/ContactSearch.vue`

**Step 1: Add scroll-into-view for keyboard navigation in QuickSearchModal**

When `selectedIndex` changes, scroll the selected item into view:
```typescript
const listRef = ref<HTMLElement>();
watch(selectedIndex, (idx) => {
  const el = listRef.value?.children[idx + 1] as HTMLElement; // +1 for section label
  el?.scrollIntoView({ block: "nearest" });
});
```

**Step 2: Add fade transition for list changes in sidebar**

Wrap the search results / chat list switch with a `<transition name="fade">` for smooth appearance.

**Step 3: Add "no results" state with clear button in sidebar**

If all three sections are empty:
```vue
<div class="flex flex-col items-center gap-2 py-8 text-sm text-text-on-main-bg-color">
  <span>{{ t('contactSearch.noResults') }}</span>
  <button class="text-color-txt-ac hover:underline" @click="emit('clear')">
    {{ t('contactSearch.clearSearch') }}
  </button>
</div>
```

**Step 4: Add i18n key**

```typescript
// en.ts
"contactSearch.clearSearch": "Clear search",
// ru.ts
"contactSearch.clearSearch": "Очистить поиск",
```

**Step 5: Verify and commit**

```bash
git add -A
git commit -m "feat(search): polish keyboard nav, transitions, and empty states"
```

---

### Task 6: Update feature barrel exports and cleanup

**Files:**
- Modify: `src/features/contacts/index.ts` — ensure ContactSearch is still exported
- Modify: `src/features/search/index.ts` — export QuickSearchModal
- Delete or clean up any unused code from old search toggle pattern

**Step 1: Update exports**

```typescript
// src/features/search/index.ts
export { useSearch } from "./model/use-search";
export { default as QuickSearchModal } from "./ui/QuickSearchModal.vue";
export type { MessageSearchResult } from "./model/use-search";
```

**Step 2: Remove `searchOpen` ref from ChatSidebar if not fully removed in Task 4**

**Step 3: Final build check**

Run: `npm run build`
Expected: Clean build, no errors

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: clean up search feature exports and remove dead code"
```
