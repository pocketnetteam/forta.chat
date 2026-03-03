# Chat Info Panel — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the existing ChatInfoPanel into a full-featured info/profile panel with action buttons, contact info, media gallery with 4 filter tabs, and user profile mode for @mention/avatar clicks.

**Architecture:** Single container component (`ChatInfoPanel.vue`) with two internal screens managed via a reactive `screen` ref. Screen 1 = main info. Screen 2 = media gallery with tabs. A separate `UserProfilePanel.vue` handles @mention/avatar click scenarios. Desktop: 360px right panel. Mobile (<640px): fullscreen overlay.

**Tech Stack:** Vue 3 Composition API, Pinia, TailwindCSS, existing Matrix SDK integration, existing `MediaViewer.vue` / `VoiceMessage.vue` / `ContextMenu.vue` / `Toggle.vue` components.

**Design doc:** `docs/plans/2026-03-03-chat-info-panel-design.md`

**Verification command:** `npx vue-tsc --noEmit` (no test framework in project)

---

### Task 1: Add i18n keys

**Files:**
- Modify: `src/shared/lib/i18n/locales/en.ts`
- Modify: `src/shared/lib/i18n/locales/ru.ts`

**Step 1: Add all chatInfo.* keys to en.ts**

Find the `info.*` block (around line 254) and add new `chatInfo.*` keys after it:

```ts
  "chatInfo.chat": "Chat",
  "chatInfo.call": "Call",
  "chatInfo.more": "More",
  "chatInfo.information": "Information",
  "chatInfo.about": "About",
  "chatInfo.website": "Website",
  "chatInfo.address": "Bastyon Address",
  "chatInfo.copied": "Copied",
  "chatInfo.notifications": "Notifications",
  "chatInfo.mediaFilesLinks": "Media, files and links",
  "chatInfo.media": "Media",
  "chatInfo.files": "Files",
  "chatInfo.links": "Links",
  "chatInfo.voice": "Voice",
  "chatInfo.members": "Members",
  "chatInfo.searchMembers": "Search members",
  "chatInfo.bannedMembers": "Banned members",
  "chatInfo.leaveGroup": "Leave group",
  "chatInfo.deleteGroup": "Delete group",
  "chatInfo.deleteChat": "Delete chat",
  "chatInfo.clearHistory": "Clear history",
  "chatInfo.blockUser": "Block user",
  "chatInfo.unblockUser": "Unblock user",
  "chatInfo.searchInChat": "Search in chat",
  "chatInfo.videoCall": "Video call",
  "chatInfo.blockedWarning": "You blocked this user",
  "chatInfo.noMedia": "No photos or videos yet",
  "chatInfo.noFiles": "No files yet",
  "chatInfo.noLinks": "No links yet",
  "chatInfo.noVoice": "No voice messages yet",
  "chatInfo.nPhotos": "{n} photos",
  "chatInfo.nVideos": "{n} videos",
  "chatInfo.nFiles": "{n} files",
  "chatInfo.mediaAndFiles": "Media and files",
  "chatInfo.editDescription": "Edit description",
  "chatInfo.addDescription": "Add description",
  "chatInfo.addMember": "Add member",
  "chatInfo.confirmLeave": "Are you sure you want to leave this group?",
  "chatInfo.confirmDelete": "Are you sure you want to delete this chat?",
  "chatInfo.confirmDeleteGroup": "This will kick all members and delete the group. Are you sure?",
  "chatInfo.confirmClear": "Are you sure you want to clear chat history?",
  "chatInfo.confirmBlock": "Are you sure you want to block this user?",
  "chatInfo.muteNotifications": "Mute notifications",
  "chatInfo.unmuteNotifications": "Unmute notifications",
```

**Step 2: Add matching keys to ru.ts**

```ts
  "chatInfo.chat": "Чат",
  "chatInfo.call": "Звонок",
  "chatInfo.more": "Ещё",
  "chatInfo.information": "Информация",
  "chatInfo.about": "О себе",
  "chatInfo.website": "Сайт",
  "chatInfo.address": "Адрес Bastyon",
  "chatInfo.copied": "Скопировано",
  "chatInfo.notifications": "Уведомления",
  "chatInfo.mediaFilesLinks": "Медиа, файлы и ссылки",
  "chatInfo.media": "Медиа",
  "chatInfo.files": "Файлы",
  "chatInfo.links": "Ссылки",
  "chatInfo.voice": "Голосовые",
  "chatInfo.members": "Участники",
  "chatInfo.searchMembers": "Поиск участников",
  "chatInfo.bannedMembers": "Заблокированные",
  "chatInfo.leaveGroup": "Покинуть группу",
  "chatInfo.deleteGroup": "Удалить группу",
  "chatInfo.deleteChat": "Удалить чат",
  "chatInfo.clearHistory": "Очистить историю",
  "chatInfo.blockUser": "Заблокировать",
  "chatInfo.unblockUser": "Разблокировать",
  "chatInfo.searchInChat": "Поиск в чате",
  "chatInfo.videoCall": "Видеозвонок",
  "chatInfo.blockedWarning": "Вы заблокировали этого пользователя",
  "chatInfo.noMedia": "Пока нет фото и видео",
  "chatInfo.noFiles": "Пока нет файлов",
  "chatInfo.noLinks": "Пока нет ссылок",
  "chatInfo.noVoice": "Пока нет голосовых сообщений",
  "chatInfo.nPhotos": "{n} фото",
  "chatInfo.nVideos": "{n} видео",
  "chatInfo.nFiles": "{n} файлов",
  "chatInfo.mediaAndFiles": "Медиа и файлы",
  "chatInfo.editDescription": "Редактировать описание",
  "chatInfo.addDescription": "Добавить описание",
  "chatInfo.addMember": "Добавить участника",
  "chatInfo.confirmLeave": "Вы уверены, что хотите покинуть группу?",
  "chatInfo.confirmDelete": "Вы уверены, что хотите удалить этот чат?",
  "chatInfo.confirmDeleteGroup": "Все участники будут удалены и группа будет удалена. Вы уверены?",
  "chatInfo.confirmClear": "Вы уверены, что хотите очистить историю чата?",
  "chatInfo.confirmBlock": "Вы уверены, что хотите заблокировать этого пользователя?",
  "chatInfo.muteNotifications": "Выключить уведомления",
  "chatInfo.unmuteNotifications": "Включить уведомления",
```

**Step 3: Verify**

Run: `npx vue-tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/shared/lib/i18n/locales/en.ts src/shared/lib/i18n/locales/ru.ts
git commit -m "feat(i18n): add chatInfo.* keys for redesigned info panel"
```

---

### Task 2: Create MediaGrid.vue (gallery media tab)

**Files:**
- Create: `src/features/chat-info/ui/MediaGrid.vue`

This is the photo/video grid for the gallery "Media" tab.

**Step 1: Create MediaGrid.vue**

```vue
<script setup lang="ts">
import type { Message } from "@/entities/chat/model/types";
import { useFileDownload } from "@/features/messaging/model/use-file-download";
import { formatDuration } from "@/shared/lib/format";

interface Props {
  messages: Message[];
}

defineProps<Props>();
const emit = defineEmits<{ select: [messageId: string] }>();
const { t } = useI18n();
const { getState, download } = useFileDownload();

/** Group messages by month (e.g. "March 2026") */
interface MonthGroup {
  label: string;
  messages: Message[];
}

const grouped = computed<MonthGroup[]>(() => {
  // props is not directly accessible in computed without using the props arg
  // We need to read it from the component instance
  return [];
});
</script>
```

Actually, since we need the props reactive, let me write the full component properly:

```vue
<script setup lang="ts">
import type { Message } from "@/entities/chat/model/types";
import { useFileDownload } from "@/features/messaging/model/use-file-download";
import { formatDuration } from "@/shared/lib/format";

const props = defineProps<{
  messages: Message[];
}>();

const emit = defineEmits<{ select: [messageId: string] }>();
const { t } = useI18n();
const { getState, download } = useFileDownload();

interface MonthGroup {
  label: string;
  messages: Message[];
}

const grouped = computed<MonthGroup[]>(() => {
  const groups: MonthGroup[] = [];
  let currentLabel = "";
  let currentGroup: Message[] = [];

  // Messages are oldest-first; we want newest-first for gallery
  const sorted = [...props.messages].sort((a, b) => b.timestamp - a.timestamp);

  for (const msg of sorted) {
    const d = new Date(msg.timestamp);
    const label = d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    if (label !== currentLabel) {
      if (currentGroup.length) groups.push({ label: currentLabel, messages: currentGroup });
      currentLabel = label;
      currentGroup = [msg];
    } else {
      currentGroup.push(msg);
    }
  }
  if (currentGroup.length) groups.push({ label: currentLabel, messages: currentGroup });
  return groups;
});

// Auto-download thumbnails as they become visible
const ensureLoaded = (msg: Message) => {
  const state = getState(msg.id);
  if (!state.objectUrl && !state.loading) download(msg);
};
</script>

<template>
  <div v-if="messages.length === 0" class="flex flex-col items-center justify-center py-16">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-text-color/20">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
    <span class="mt-3 text-sm text-text-color/40">{{ t("chatInfo.noMedia") }}</span>
  </div>

  <div v-else>
    <div v-for="group in grouped" :key="group.label" class="mb-2">
      <div class="px-3 pb-1 pt-3 text-[13px] font-medium text-text-color/50">
        {{ group.label }}
      </div>
      <div class="grid grid-cols-3 gap-0.5 px-0.5">
        <button
          v-for="msg in group.messages"
          :key="msg.id"
          class="relative aspect-square overflow-hidden rounded-sm bg-neutral-grad-0"
          @click="emit('select', msg.id)"
          @vue:mounted="ensureLoaded(msg)"
        >
          <img
            v-if="getState(msg.id).objectUrl"
            :src="getState(msg.id).objectUrl!"
            alt=""
            class="h-full w-full object-cover"
            loading="lazy"
          />
          <div v-else class="h-full w-full animate-pulse bg-neutral-grad-0" />

          <!-- Video overlay -->
          <template v-if="msg.type === 'video'">
            <div class="absolute inset-0 flex items-center justify-center">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="white" class="drop-shadow-lg">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <span
              v-if="msg.fileInfo?.duration"
              class="absolute bottom-1 right-1 rounded-full bg-black/50 px-1.5 py-0.5 text-[10px] text-white"
            >
              {{ formatDuration(msg.fileInfo.duration) }}
            </span>
          </template>
        </button>
      </div>
    </div>
  </div>
</template>
```

**Step 2: Verify**

Run: `npx vue-tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/features/chat-info/ui/MediaGrid.vue
git commit -m "feat(chat-info): add MediaGrid component for photo/video gallery"
```

---

### Task 3: Create FilesList.vue (gallery files tab)

**Files:**
- Create: `src/features/chat-info/ui/FilesList.vue`

**Step 1: Create FilesList.vue**

Props: `messages: Message[]` (filtered to type `file`).

File type icon color logic: PDF → red, spreadsheet (xlsx/csv) → green, document (doc/txt) → blue, archive (zip/rar) → yellow, generic → gray.

Each row shows: icon + filename (truncated) + size + date. Click → download via `use-file-download`.

Group by month like MediaGrid.

**Step 2: Verify** — `npx vue-tsc --noEmit`

**Step 3: Commit**

```bash
git add src/features/chat-info/ui/FilesList.vue
git commit -m "feat(chat-info): add FilesList component for file gallery tab"
```

---

### Task 4: Create LinksList.vue (gallery links tab)

**Files:**
- Create: `src/features/chat-info/ui/LinksList.vue`

**Step 1: Create LinksList.vue**

Props: `messages: Message[]` (all text messages).

Extract links from message text using the existing `URL_RE` regex from `src/shared/lib/message-format.ts`. For each extracted link, show: URL (truncated, accent color) + message context (first 60 chars of message text, muted) + date. Click → `window.open(url, "_blank")`.

Build a computed that scans all text messages for URLs, deduplicates, and groups by month.

**Step 2: Verify** — `npx vue-tsc --noEmit`

**Step 3: Commit**

```bash
git add src/features/chat-info/ui/LinksList.vue
git commit -m "feat(chat-info): add LinksList component for link gallery tab"
```

---

### Task 5: Create VoiceList.vue (gallery voice tab)

**Files:**
- Create: `src/features/chat-info/ui/VoiceList.vue`

**Step 1: Create VoiceList.vue**

Props: `messages: Message[]` (filtered to type `audio`).

Reuses existing `VoiceMessage.vue` component. Each row shows the VoiceMessage player. Group by month.

Need to determine `isOwn` by comparing `msg.senderId` with `authStore.address`.

**Step 2: Verify** — `npx vue-tsc --noEmit`

**Step 3: Commit**

```bash
git add src/features/chat-info/ui/VoiceList.vue
git commit -m "feat(chat-info): add VoiceList component for voice gallery tab"
```

---

### Task 6: Create ChatInfoGallery.vue (Screen 2 — gallery with tabs)

**Files:**
- Create: `src/features/chat-info/ui/ChatInfoGallery.vue`

**Step 1: Create ChatInfoGallery.vue**

Props: `initialTab?: "media" | "files" | "links" | "voice"` (default: "media").

Emits: `back` (returns to Screen 1).

Contains:
- Header with ← back button + title "Media and files"
- 4 text tabs (Media / Files / Links / Voice) with sliding underline
- Tab content area rendering the appropriate sub-component

Tab state: `activeTab` ref initialized from `initialTab` prop.

Data: all filtered message arrays computed from `chatStore.activeMessages`:
- `mediaMessages`: type === "image" || type === "video"
- `fileMessages`: type === "file"
- `voiceMessages`: type === "audio"
- `textMessages`: type === "text" (for link extraction)

Imports and renders: `MediaGrid`, `FilesList`, `LinksList`, `VoiceList`.

MediaGrid gets `@select` event → opens `MediaViewer.vue` (import and render within gallery).

**Step 2: Verify** — `npx vue-tsc --noEmit`

**Step 3: Commit**

```bash
git add src/features/chat-info/ui/ChatInfoGallery.vue
git commit -m "feat(chat-info): add ChatInfoGallery with 4 filter tabs"
```

---

### Task 7: Rewrite ChatInfoPanel.vue (container + Screen 1)

**Files:**
- Modify: `src/features/chat-info/ui/ChatInfoPanel.vue` (full rewrite)

This is the largest task. The current file is a single monolithic 663-line component. We rewrite it as a container with internal navigation.

**Step 1: Rewrite ChatInfoPanel.vue**

The new structure:

```
ChatInfoPanel.vue
├── screen: ref<"main" | "gallery">
├── Screen "main": all existing functionality + new sections
│   ├── Profile block (avatar, name, subtitle) — moved from existing
│   ├── Action buttons (Chat, Call, More) — NEW
│   ├── Contact info section (about, site, address) — NEW
│   ├── Notifications toggle — moved from existing, use Toggle.vue
│   ├── Media preview (last 4 thumbnails + counters) — NEW
│   ├── Members section — moved from existing
│   └── Danger zone — moved from existing
└── Screen "gallery": <ChatInfoGallery />
```

Key changes from existing:
1. Width changed from `w-[320px]` to `w-[360px]`
2. Mobile: `sm:w-[360px] w-full` for fullscreen on mobile
3. Add `screen` ref for internal navigation
4. Add action buttons row (Chat, Call, More)
5. Add More context menu using `ContextMenu.vue`
6. Add contact info section (load user data via `authStore.loadUsersInfo` + `authStore.getBastyonUserData`)
7. Replace inline toggle with `Toggle.vue` component
8. Add media preview section with thumbnails
9. Add slide transitions between screens
10. Add mobile back button (← on mobile, ✕ on desktop)
11. Replace all hardcoded strings with `t("chatInfo.*")` calls
12. All existing member management logic preserved exactly as-is

Important implementation details:

**Contact info loading** (1:1 chats only):
```ts
const peerAddress = computed(() => { /* same logic as otherMemberAddress in ChatWindow */ });
const peerData = ref<{ name: string; about: string; site: string; image: string } | null>(null);

watch(() => peerAddress.value, async (addr) => {
  if (!addr) return;
  await authStore.loadUsersInfo([addr]);
  peerData.value = authStore.getBastyonUserData(addr) ?? null;
}, { immediate: true });
```

**Action buttons — More menu:**
```ts
const moreMenuRef = ref<HTMLElement | null>(null);
const showMoreMenu = ref(false);
const moreMenuPos = ref({ x: 0, y: 0 });

const openMoreMenu = (e: MouseEvent) => {
  moreMenuPos.value = { x: e.clientX, y: e.clientY };
  showMoreMenu.value = true;
};

const moreMenuItems = computed(() => {
  const items: ContextMenuItem[] = [];
  if (!room.value?.isGroup) {
    items.push({ label: t("chatInfo.videoCall"), icon: VIDEO_ICON_SVG, action: "videoCall" });
  }
  items.push({ label: t("chatInfo.searchInChat"), icon: SEARCH_ICON_SVG, action: "search" });
  items.push({
    label: isMuted.value ? t("chatInfo.unmuteNotifications") : t("chatInfo.muteNotifications"),
    icon: BELL_ICON_SVG,
    action: "toggleMute",
  });
  // separator via a special item or group — ContextMenu doesn't support separators,
  // so use danger items at the end
  items.push({ label: t("chatInfo.clearHistory"), icon: TRASH_ICON_SVG, action: "clearHistory" });
  if (!room.value?.isGroup) {
    items.push({ label: t("chatInfo.blockUser"), icon: BAN_ICON_SVG, action: "block", danger: true });
    items.push({ label: t("chatInfo.deleteChat"), icon: TRASH_ICON_SVG, action: "deleteChat", danger: true });
  } else {
    items.push({ label: t("chatInfo.leaveGroup"), icon: LOGOUT_ICON_SVG, action: "leave", danger: true });
    if (isAdmin.value) {
      items.push({ label: t("chatInfo.deleteGroup"), icon: TRASH_ICON_SVG, action: "deleteGroup", danger: true });
    }
  }
  return items;
});

const handleMoreAction = (action: string) => {
  switch (action) {
    case "videoCall": startCall("video"); break;
    case "search": emit("close"); emit("openSearch"); break;
    case "toggleMute": toggleMute(); break;
    case "clearHistory": confirmAction.value = "clear"; break;
    case "block": confirmAction.value = "block"; break;
    case "deleteChat": confirmAction.value = "delete"; break;
    case "leave": confirmAction.value = "leave"; break;
    case "deleteGroup": confirmAction.value = "delete"; break;
  }
};
```

**SVG icon strings** for ContextMenu items: Define as `const` strings at the top of the script (ContextMenu uses `v-html` for icons):
```ts
const VIDEO_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';
// ... etc for each icon
```

**Media preview section:**
```ts
const recentMedia = computed(() =>
  chatStore.activeMessages
    .filter(m => m.type === "image" || m.type === "video")
    .slice(-4)
    .reverse()
);
```

Use `useFileDownload()` to load thumbnails for the 4 preview items.

**Screen transitions:**
```css
.screen-slide-left-enter-active,
.screen-slide-left-leave-active,
.screen-slide-right-enter-active,
.screen-slide-right-leave-active {
  transition: transform 0.2s ease-in-out, opacity 0.2s ease-in-out;
}
.screen-slide-left-enter-from { transform: translateX(100%); opacity: 0; }
.screen-slide-left-leave-to { transform: translateX(-30%); opacity: 0; }
.screen-slide-right-enter-from { transform: translateX(-30%); opacity: 0; }
.screen-slide-right-leave-to { transform: translateX(100%); opacity: 0; }
```

**Emits update:**
```ts
const emit = defineEmits<{
  close: [];
  openSearch: [];  // NEW — tells ChatWindow to open search
}>();
```

**Step 2: Verify** — `npx vue-tsc --noEmit`

**Step 3: Commit**

```bash
git add src/features/chat-info/ui/ChatInfoPanel.vue
git commit -m "feat(chat-info): redesign ChatInfoPanel with action buttons, contact info, media preview, gallery"
```

---

### Task 8: Update ChatWindow.vue integration

**Files:**
- Modify: `src/widgets/chat-window/ChatWindow.vue`

**Step 1: Handle new `openSearch` emit from ChatInfoPanel**

In the template, update:
```html
<ChatInfoPanel
  :show="showInfoPanel"
  @close="showInfoPanel = false"
  @open-search="showSearch = true"
/>
```

This ensures that when "Search in chat" is selected from the More menu in the info panel, the panel closes and the search bar opens.

**Step 2: Verify** — `npx vue-tsc --noEmit`

**Step 3: Commit**

```bash
git add src/widgets/chat-window/ChatWindow.vue
git commit -m "feat(chat-window): wire up openSearch event from ChatInfoPanel"
```

---

### Task 9: Add @mention and avatar click handlers

**Files:**
- Modify: `src/features/messaging/ui/MessageContent.vue` — add click handler on mention spans
- Modify: `src/features/messaging/ui/MessageBubble.vue` — add click handler on sender avatar
- Create: `src/features/chat-info/ui/UserProfilePanel.vue` — lightweight user profile panel
- Modify: `src/features/chat-info/index.ts` — export new component
- Modify: `src/widgets/chat-window/ChatWindow.vue` — render UserProfilePanel

**Step 1: Create UserProfilePanel.vue**

A simplified panel that shows a single user's profile (not a room). Props:

```ts
interface Props {
  show: boolean;
  address: string;  // raw Bastyon address
}
```

Emits: `close`.

Shows:
- Avatar (80px, from UserAvatar)
- Name, about, site, address (loaded via `authStore.loadUsersInfo`)
- Action buttons: Chat (open/create 1:1 chat), Call (voice), More (video call)
- No media section, no members section

The "Chat" button logic:
```ts
// Find existing 1:1 room with this user, or create one
const existingRoom = chatStore.sortedRooms.find(r =>
  !r.isGroup && r.members.includes(hexEncode(props.address))
);
if (existingRoom) {
  chatStore.setActiveRoom(existingRoom.id);
} else {
  // Use contacts composable to start a chat
  // This creates a new DM room via Matrix
}
emit("close");
```

Uses same styling (360px, slide from right) as ChatInfoPanel.

**Step 2: Add click handler to mentions in MessageContent.vue**

Currently mention spans have no click handler:
```html
<span v-else-if="seg.type === 'mention'" class="cursor-pointer font-medium text-color-txt-ac">
  {{ seg.content }}
</span>
```

Add an emit:
```ts
const emit = defineEmits<{ mentionClick: [userId: string] }>();
```

Update template:
```html
<span
  v-else-if="seg.type === 'mention'"
  class="cursor-pointer font-medium text-color-txt-ac"
  @click.stop="emit('mentionClick', seg.userId)"
>{{ seg.content }}</span>
```

Both branches (block and inline) need updating.

**Step 3: Wire up in MessageBubble.vue**

MessageBubble renders `<MessageContent>`. Forward the `mentionClick` event up:
```html
<MessageContent :text="msg.content" :is-own="isOwn" @mention-click="$emit('mentionClick', $event)" />
```

Add sender avatar click (in group chats):
```html
<button @click="$emit('avatarClick', msg.senderId)">
  <UserAvatar :address="msg.senderId" size="sm" />
</button>
```

Add to emits:
```ts
const emit = defineEmits<{
  // existing emits...
  mentionClick: [userId: string];
  avatarClick: [address: string];
}>();
```

**Step 4: Wire up in MessageList.vue → ChatWindow.vue**

Propagate events up the chain until ChatWindow can open `UserProfilePanel`.

In ChatWindow.vue:
```ts
const profileAddress = ref("");
const showUserProfile = ref(false);

const openUserProfile = (address: string) => {
  profileAddress.value = address;
  showUserProfile.value = true;
};
```

```html
<UserProfilePanel
  :show="showUserProfile"
  :address="profileAddress"
  @close="showUserProfile = false"
/>
```

**Step 5: Update index.ts**

```ts
export { default as ChatInfoPanel } from "./ui/ChatInfoPanel.vue";
export { default as UserProfilePanel } from "./ui/UserProfilePanel.vue";
```

**Step 6: Verify** — `npx vue-tsc --noEmit`

**Step 7: Commit**

```bash
git add src/features/chat-info/ui/UserProfilePanel.vue \
        src/features/chat-info/index.ts \
        src/features/messaging/ui/MessageContent.vue \
        src/features/messaging/ui/MessageBubble.vue \
        src/widgets/chat-window/ChatWindow.vue
git commit -m "feat(chat-info): add UserProfilePanel + mention/avatar click navigation"
```

---

### Task 10: Final verification and cleanup

**Files:**
- All modified files

**Step 1: Full type check**

Run: `npx vue-tsc --noEmit`
Expected: PASS with no errors

**Step 2: Manual smoke test checklist**

1. Open a 1:1 chat → click header → panel opens with avatar, name, address, action buttons
2. Click "Chat" → panel closes, focus on input
3. Click "Call" → initiates voice call
4. Click "More" → context menu with video call, search, mute, clear, block, delete
5. Scroll down → see contact info (about, site, address)
6. Click Bastyon address → copies to clipboard, toast appears
7. See media preview thumbnails (last 4)
8. Click "Media, files and links" → gallery opens with slide animation
9. Gallery: switch between Media/Files/Links/Voice tabs
10. Media tab: 3-column grid, click thumbnail → MediaViewer opens
11. Files tab: file list with icons, click → download
12. Links tab: extracted URLs from messages
13. Voice tab: voice messages with waveform players
14. Click ← in gallery → returns to main screen
15. Open a group chat → see members, admin actions work
16. Click @mention in message → UserProfilePanel opens for that user
17. Click avatar in group message → UserProfilePanel opens
18. Mobile viewport (<640px) → panel is fullscreen, ← button visible

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix(chat-info): polish after smoke testing"
```

---

## File Summary

| File | Action | Task |
|------|--------|------|
| `src/shared/lib/i18n/locales/en.ts` | Modify | 1 |
| `src/shared/lib/i18n/locales/ru.ts` | Modify | 1 |
| `src/features/chat-info/ui/MediaGrid.vue` | Create | 2 |
| `src/features/chat-info/ui/FilesList.vue` | Create | 3 |
| `src/features/chat-info/ui/LinksList.vue` | Create | 4 |
| `src/features/chat-info/ui/VoiceList.vue` | Create | 5 |
| `src/features/chat-info/ui/ChatInfoGallery.vue` | Create | 6 |
| `src/features/chat-info/ui/ChatInfoPanel.vue` | Rewrite | 7 |
| `src/widgets/chat-window/ChatWindow.vue` | Modify | 8, 9 |
| `src/features/chat-info/ui/UserProfilePanel.vue` | Create | 9 |
| `src/features/chat-info/index.ts` | Modify | 9 |
| `src/features/messaging/ui/MessageContent.vue` | Modify | 9 |
| `src/features/messaging/ui/MessageBubble.vue` | Modify | 9 |

## Key References

- **Design doc:** `docs/plans/2026-03-03-chat-info-panel-design.md`
- **Current ChatInfoPanel:** `src/features/chat-info/ui/ChatInfoPanel.vue` (663 lines, all logic preserved)
- **ContextMenu API:** `src/shared/ui/context-menu/ContextMenu.vue` — `{show, x, y, items}` props, `{close, select}` emits
- **Toggle API:** `src/shared/ui/toggle/Toggle.vue` — `v-model:modelValue`, `size="sm"|"md"`, `disabled`
- **MediaViewer API:** `src/features/messaging/ui/MediaViewer.vue` — `{show, messageId}` props, `{close}` emit
- **VoiceMessage API:** `src/features/messaging/ui/VoiceMessage.vue` — `{message, isOwn}` props
- **useFileDownload:** `src/features/messaging/model/use-file-download.ts` — `{getState, download, formatSize}`
- **Chat store:** `src/entities/chat/model/chat-store.ts` — activeMessages, toggleMuteRoom, getRoomPowerLevels, etc.
- **Auth store:** `src/entities/auth/model/stores.ts` — loadUsersInfo, getBastyonUserData
- **URL regex:** `src/shared/lib/message-format.ts` — `URL_RE` for link extraction
- **Hex encode/decode:** `src/shared/lib/matrix/functions.ts` — hexEncode, hexDecode
- **Call service:** `src/features/video-calls/model/call-service.ts` — useCallService().startCall(roomId, type)
