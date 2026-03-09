# In-Chat Search Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the in-chat search (Cmd+F) with results dropdown, user filter chips, and smooth highlight animation.

**Architecture:** Rewrite `ChatSearch.vue` as a self-contained component with dropdown results panel, user picker dropdown, and chip-based user filter. MessageList's highlight animation updated to use theme accent color with a 2-pulse glow. ChatWindow integration stays the same (same events: close, scrollTo, update:query).

**Tech Stack:** Vue 3 Composition API, Tailwind CSS, existing `splitByQuery` utility, existing `useFormatPreview` composable

---

### Task 1: Improve highlight animation in MessageList

**Files:**
- Modify: `src/features/messaging/ui/MessageList.vue:807-815`

**Step 1: Replace the search-flash animation**

In `MessageList.vue`, replace the current `<style>` block (lines 807-815):

```css
/* OLD */
@keyframes search-flash {
  0% { background-color: rgba(var(--color-bg-ac-rgb, 59, 130, 246), 0.25); }
  100% { background-color: transparent; }
}
.search-highlight {
  animation: search-flash 1.5s ease-out;
  border-radius: 8px;
}
```

With:

```css
@keyframes search-flash {
  0%   { background-color: rgba(var(--color-bg-ac-bright), 0.25); }
  40%  { background-color: rgba(var(--color-bg-ac-bright), 0.08); }
  60%  { background-color: rgba(var(--color-bg-ac-bright), 0.2); }
  100% { background-color: transparent; }
}
.search-highlight {
  animation: search-flash 2s ease-out;
  border-radius: 8px;
}
```

This creates a 2-pulse "breathing" effect using the theme accent color, visible in both dark and light themes.

**Step 2: Verify visually**

Run: `npm run dev`, open a chat, use Cmd+F to search, navigate to a result. The message should pulse with the accent color twice before fading.

**Step 3: Commit**

```bash
git add src/features/messaging/ui/MessageList.vue
git commit -m "feat(search): improve message highlight animation with accent color pulse"
```

---

### Task 2: Rewrite ChatSearch.vue with dropdown and user filter

**Files:**
- Modify: `src/features/messaging/ui/ChatSearch.vue` (full rewrite)
- Modify: `src/shared/lib/i18n/locales/en.ts`
- Modify: `src/shared/lib/i18n/locales/ru.ts`

**Step 1: Rewrite ChatSearch.vue**

Full replacement of `src/features/messaging/ui/ChatSearch.vue`:

```vue
<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { useChatStore } from "@/entities/chat";
import type { Message } from "@/entities/chat";
import { UserAvatar } from "@/entities/user";
import { splitByQuery } from "@/shared/lib/utils/highlight";
import { useFormatPreview } from "@/shared/lib/utils/format-preview";
import { formatRelativeTime } from "@/shared/lib/format";
import { hexDecode } from "@/shared/lib/matrix/functions";

const emit = defineEmits<{
  close: [];
  scrollTo: [messageId: string];
  "update:query": [query: string];
}>();

const chatStore = useChatStore();
const { t } = useI18n();
const { formatPreview } = useFormatPreview();

// --- State ---
const query = ref("");
const filterUser = ref<string | null>(null); // address of user filter
const currentIndex = ref(0);
const allLoaded = ref(false);
const loadingAll = ref(false);
const showDropdown = ref(false);
const showUserPicker = ref(false);
const selectedDropdownIndex = ref(0);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const debouncedQuery = ref("");

// --- Debounced query ---
watch(query, (val) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    debouncedQuery.value = val;
    currentIndex.value = 0;
    selectedDropdownIndex.value = 0;
    emit("update:query", val);

    const roomId = chatStore.activeRoomId;
    if ((val.trim() || filterUser.value) && roomId && !allLoaded.value) {
      loadingAll.value = true;
      await chatStore.loadAllMessages(roomId);
      allLoaded.value = true;
      loadingAll.value = false;
    }
  }, 250);
});

// --- Matches ---
const matches = computed((): Message[] => {
  let msgs = chatStore.activeMessages;

  // Filter by user
  if (filterUser.value) {
    msgs = msgs.filter(m => m.senderId === filterUser.value);
  }

  // Filter by query
  const q = debouncedQuery.value.toLowerCase().trim();
  if (q) {
    msgs = msgs.filter(m => m.content && m.content.toLowerCase().includes(q));
  }

  // If no filters active, return empty
  if (!filterUser.value && !q) return [];

  return msgs;
});

const totalMatches = computed(() => matches.value.length);

// Show dropdown when there are results and query or filter is active
watch([debouncedQuery, filterUser], () => {
  showDropdown.value = (debouncedQuery.value.trim() !== "" || filterUser.value !== null) && matches.value.length > 0;
  selectedDropdownIndex.value = 0;
});

// --- Navigation ---
const goTo = (index: number) => {
  if (matches.value.length === 0) return;
  currentIndex.value = ((index % matches.value.length) + matches.value.length) % matches.value.length;
  const msg = matches.value[currentIndex.value];
  if (msg) emit("scrollTo", msg.id);
};

const goNext = () => goTo(currentIndex.value + 1);
const goPrev = () => goTo(currentIndex.value - 1);

// Auto-navigate to last match when results change
watch(matches, (val) => {
  if (val.length > 0) goTo(val.length - 1);
});

// --- Dropdown item select ---
const selectDropdownItem = (index: number) => {
  currentIndex.value = index;
  const msg = matches.value[index];
  if (msg) emit("scrollTo", msg.id);
  showDropdown.value = false;
};

// --- Dropdown keyboard nav ---
const handleDropdownKeydown = (e: KeyboardEvent) => {
  if (!showDropdown.value || matches.value.length === 0) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedDropdownIndex.value = (selectedDropdownIndex.value + 1) % Math.min(matches.value.length, 50);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    const len = Math.min(matches.value.length, 50);
    selectedDropdownIndex.value = (selectedDropdownIndex.value - 1 + len) % len;
  } else if (e.key === "Enter") {
    e.preventDefault();
    selectDropdownItem(selectedDropdownIndex.value);
  }
};

// --- User picker ---
const roomMembers = computed(() => {
  const room = chatStore.activeRoom;
  if (!room) return [];
  return room.members.map(hexId => {
    const addr = hexDecode(hexId);
    return {
      address: addr,
      name: chatStore.getDisplayName(addr),
      hexId,
    };
  });
});

const selectUser = (address: string) => {
  filterUser.value = address;
  showUserPicker.value = false;
  showDropdown.value = true;
  // Trigger re-search
  if (debounceTimer) clearTimeout(debounceTimer);
  debouncedQuery.value = query.value;
  nextTick(() => inputRef.value?.focus());
};

const removeUserFilter = () => {
  filterUser.value = null;
  nextTick(() => inputRef.value?.focus());
};

// Backspace on empty input removes user filter
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === "Backspace" && query.value === "" && filterUser.value) {
    e.preventDefault();
    removeUserFilter();
  }
  handleDropdownKeydown(e);
};

const filterUserName = computed(() => {
  if (!filterUser.value) return "";
  return chatStore.getDisplayName(filterUser.value);
});

// --- Dropdown display items (limited to 50) ---
const dropdownItems = computed(() => matches.value.slice(0, 50));

// Scroll dropdown selected item into view
const dropdownRef = ref<HTMLElement>();
watch(selectedDropdownIndex, (idx) => {
  if (!dropdownRef.value) return;
  const el = dropdownRef.value.children[idx] as HTMLElement;
  el?.scrollIntoView({ block: "nearest" });
});

const inputRef = ref<HTMLInputElement>();

onMounted(() => {
  inputRef.value?.focus();
});

// Close dropdowns on outside events
const closeAll = () => {
  showDropdown.value = false;
  showUserPicker.value = false;
};

const handleClose = () => {
  closeAll();
  emit("close");
};
</script>

<template>
  <div class="relative shrink-0">
    <!-- Search bar -->
    <div class="flex h-12 items-center gap-1.5 border-b border-neutral-grad-0 bg-background-total-theme px-2">
      <!-- Close button -->
      <button
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
        @click="handleClose"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
        </svg>
      </button>

      <!-- Input area with optional chip -->
      <div class="flex min-w-0 flex-1 items-center gap-1.5">
        <!-- User filter chip -->
        <button
          v-if="filterUser"
          class="flex shrink-0 items-center gap-1 rounded-full bg-color-txt-ac/15 px-2 py-0.5 text-xs font-medium text-color-txt-ac"
          @click="removeUserFilter"
        >
          <span class="max-w-[120px] truncate">{{ filterUserName }}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <input
          ref="inputRef"
          v-model="query"
          type="text"
          :placeholder="filterUser ? t('chatSearch.filterPlaceholder') : t('chatSearch.placeholder')"
          class="min-w-0 flex-1 bg-transparent text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
          @keydown="handleKeydown"
          @keydown.escape="handleClose"
          @focus="showDropdown = matches.length > 0"
        />
      </div>

      <!-- User filter button -->
      <button
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
        :class="filterUser ? 'text-color-txt-ac' : ''"
        :title="t('chatSearch.filterByUser')"
        @click="showUserPicker = !showUserPicker; showDropdown = false"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      </button>

      <!-- Results counter -->
      <span v-if="debouncedQuery || filterUser" class="shrink-0 text-xs tabular-nums text-text-on-main-bg-color">
        <template v-if="loadingAll">...</template>
        <template v-else-if="totalMatches > 0">{{ currentIndex + 1 }}/{{ totalMatches }}</template>
        <template v-else>0</template>
      </span>

      <!-- Nav buttons -->
      <button
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0 disabled:opacity-30"
        :disabled="totalMatches === 0"
        @click="goPrev"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>

      <button
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0 disabled:opacity-30"
        :disabled="totalMatches === 0"
        @click="goNext"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
    </div>

    <!-- Results dropdown -->
    <div
      v-if="showDropdown && dropdownItems.length"
      ref="dropdownRef"
      class="absolute inset-x-0 top-12 z-30 max-h-[300px] overflow-y-auto border-b border-neutral-grad-0 bg-background-total-theme shadow-lg"
    >
      <button
        v-for="(msg, i) in dropdownItems"
        :key="msg.id"
        class="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors"
        :class="i === selectedDropdownIndex ? 'bg-neutral-grad-0' : 'hover:bg-neutral-grad-0/50'"
        @click="selectDropdownItem(i)"
        @mouseenter="selectedDropdownIndex = i"
      >
        <UserAvatar :address="msg.senderId" size="xs" />
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="truncate text-xs font-medium text-text-color">{{ chatStore.getDisplayName(msg.senderId) }}</span>
            <span class="shrink-0 text-[10px] text-text-on-main-bg-color">{{ formatRelativeTime(new Date(msg.timestamp)) }}</span>
          </div>
          <div class="truncate text-sm text-text-on-main-bg-color">
            <template v-if="debouncedQuery.trim()">
              <template v-for="(part, j) in splitByQuery(msg.content, debouncedQuery.trim())" :key="j">
                <mark v-if="part.highlight" class="rounded-sm bg-color-txt-ac/20 font-semibold text-color-txt-ac">{{ part.text }}</mark>
                <span v-else>{{ part.text }}</span>
              </template>
            </template>
            <span v-else>{{ msg.content }}</span>
          </div>
        </div>
      </button>
    </div>

    <!-- User picker dropdown -->
    <div
      v-if="showUserPicker"
      class="absolute inset-x-0 top-12 z-30 max-h-[250px] overflow-y-auto border-b border-neutral-grad-0 bg-background-total-theme shadow-lg"
    >
      <div class="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-on-main-bg-color">
        {{ t("chatSearch.members") }}
      </div>
      <button
        v-for="member in roomMembers"
        :key="member.address"
        class="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-neutral-grad-0"
        @click="selectUser(member.address)"
      >
        <UserAvatar :address="member.address" size="xs" />
        <span class="truncate text-sm font-medium text-text-color">{{ member.name }}</span>
      </button>
    </div>
  </div>
</template>
```

**Step 2: Add i18n keys**

Add to `en.ts`:
```
"chatSearch.placeholder": "Search in chat...",
"chatSearch.filterPlaceholder": "Filter messages...",
"chatSearch.filterByUser": "Filter by user",
"chatSearch.members": "Members",
```

Add to `ru.ts`:
```
"chatSearch.placeholder": "Поиск в чате...",
"chatSearch.filterPlaceholder": "Фильтр сообщений...",
"chatSearch.filterByUser": "Фильтр по пользователю",
"chatSearch.members": "Участники",
```

**Step 3: Verify build**

Run: `npx vue-tsc --noEmit`

**Step 4: Commit**

```bash
git add src/features/messaging/ui/ChatSearch.vue src/shared/lib/i18n/locales/
git commit -m "feat(search): rewrite in-chat search with dropdown results and user filter"
```

---

### Task 3: Close dropdown on outside click and polish

**Files:**
- Modify: `src/features/messaging/ui/ChatSearch.vue`

**Step 1: Add click-outside handler**

The dropdown and user picker should close when clicking outside. Add a click-outside detection:

In the component's root `<div class="relative shrink-0">`, add:
```
@click.stop
```

And in the parent (the messages area below), clicks will naturally not be on the search component, so we handle this by watching for `scrollTo` events (dropdown already closes on item select).

Also close both dropdowns when the user starts scrolling in the message list by watching `showDropdown`:
- When a result is selected via dropdown click, `showDropdown` is already set to false.
- When navigating with ▲▼ buttons, close the dropdown.

Add to goNext/goPrev:
```typescript
showDropdown.value = false;
```

**Step 2: Add Enter key behavior**

When dropdown is NOT visible but there are matches, Enter should navigate to next match (current behavior). When dropdown IS visible, Enter selects the highlighted item (handled by handleDropdownKeydown).

The current `@keydown.enter` on the input should be removed since `handleKeydown` + `handleDropdownKeydown` already handles Enter when dropdown is visible. For the non-dropdown case, add Enter handling:

In `handleKeydown`:
```typescript
if (e.key === "Enter" && !showDropdown.value) {
  e.preventDefault();
  goNext();
}
```

**Step 3: Verify and commit**

```bash
git add src/features/messaging/ui/ChatSearch.vue
git commit -m "feat(search): polish dropdown close behavior and keyboard navigation"
```
