# Bastyon Channels Tab Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Channels" tab in chat folder filters that displays Bastyon channel subscriptions as chat-like entries, with channel posts rendered as message bubbles.

**Architecture:** Parallel entity approach — channels have their own Pinia store (`useChannelStore`) and dedicated components, separate from Matrix chat infrastructure. They integrate visually into the chat list via FolderTabs and merge with chats in the "All" tab sorted by time.

**Tech Stack:** Vue 3 + Pinia + TypeScript + Tailwind CSS, Bastyon RPC API (`getsubscribeschannels`, `getprofilefeed`), vue-virtual-scroller

---

### Task 1: Create channel types

**Files:**
- Create: `src/entities/channel/model/types.ts`

**Step 1: Create types file**

```typescript
export interface ChannelPost {
  txid: string
  type: 'video' | 'share' | 'article'
  caption: string
  message: string
  time: number
  height: number
  scoreSum: number
  scoreCnt: number
  comments: number
  images?: string[]
  url?: string
  tags?: string[]
  settings?: { v?: string }
}

export interface Channel {
  address: string
  name: string
  avatar: string
  lastContent: ChannelPost | null
}
```

**Step 2: Commit**

```bash
git add src/entities/channel/model/types.ts
git commit -m "feat(channels): add Channel and ChannelPost type definitions"
```

---

### Task 2: Create Bastyon RPC service

**Files:**
- Create: `src/shared/api/bastyon-rpc.ts`

**Step 1: Create RPC service**

This service wraps the existing `Api` global (same pattern as `app-initializer.ts`). It calls `getsubscribeschannels` and `getprofilefeed` via `this.api.rpc()`.

```typescript
import type { Channel, ChannelPost } from "@/entities/channel/model/types";

/**
 * Bastyon RPC service for channel-related API calls.
 * Uses the same Api global as AppInitializer.
 */
class BastyonRpcService {
  private api: InstanceType<typeof Api> | null = null;

  init() {
    if (typeof Api === "undefined") {
      console.warn("[BastyonRpc] Api global not available");
      return;
    }
    // Reuse the same PocketnetInstance used by AppInitializer
    const { PocketnetInstance } = require("@/app/providers/chat-scripts/config/pocketnetinstance");
    this.api = new Api(PocketnetInstance);
  }

  get available(): boolean {
    return this.api !== null;
  }

  /**
   * Fetch subscribed channels for a user address.
   * RPC: getsubscribeschannels [address, blockNumber, page, pageSize, 1]
   */
  async getSubscribesChannels(
    address: string,
    blockNumber: number = 0,
    page: number = 0,
    pageSize: number = 20,
  ): Promise<{ channels: Channel[]; height: number }> {
    if (!this.api) throw new Error("API not available");
    const data = await this.api.rpc("getsubscribeschannels", [
      address, blockNumber, page, pageSize, 1,
    ]);
    const result = (data as any)?.result ?? data;
    const height = result?.height ?? 0;
    const rawChannels = result?.channels ?? [];

    const channels: Channel[] = rawChannels.map((ch: any) => ({
      address: ch.address ?? "",
      name: ch.name ? decodeURIComponent(ch.name) : "",
      avatar: ch.avatar ?? "",
      lastContent: ch.lastContent ? parseChannelPost(ch.lastContent) : null,
    }));

    return { channels, height };
  }

  /**
   * Fetch profile feed (posts) for a channel address.
   * RPC: getprofilefeed [height, txid, count, lang, tagsfilter, type, [], [], tagsexcluded, keyword, author]
   *
   * Uses the `hierarchical` parameter format from pocketnet satolist.js.
   * For getprofilefeed, the author address is pushed as the 11th parameter.
   */
  async getProfileFeed(
    authorAddress: string,
    options: {
      height?: number;
      startTxid?: string;
      count?: number;
      lang?: string;
    } = {},
  ): Promise<ChannelPost[]> {
    if (!this.api) throw new Error("API not available");

    const height = options.height ?? 0;
    const txid = options.startTxid ?? "";
    const count = options.count ?? 10;
    const lang = options.lang ?? "";

    // Parameter order matches pocketnet satolist.js hierarchical():
    // [height, txid, count, lang, tagsfilter, type, reserved, reserved, tagsexcluded, keyword, author]
    const params = [
      Number(height),  // 0: block height
      txid,            // 1: pagination txid
      count,           // 2: items count
      lang,            // 3: language
      [],              // 4: tagsfilter
      [],              // 5: type filter
      [],              // 6: reserved
      [],              // 7: reserved
      [],              // 8: tagsexcluded
      "",              // 9: keyword
      authorAddress,   // 10: author address
    ];

    const data = await this.api.rpc("getprofilefeed", params);
    const items = Array.isArray(data) ? data : (data as any)?.contents ?? [];
    return items.map(parseChannelPost);
  }
}

function parseChannelPost(raw: any): ChannelPost {
  const tryDecode = (val: unknown): string => {
    if (typeof val !== "string") return "";
    try { return decodeURIComponent(val); } catch { return val as string; }
  };

  return {
    txid: raw.txid ?? "",
    type: raw.type ?? "share",
    caption: tryDecode(raw.caption ?? raw.c ?? ""),
    message: tryDecode(raw.message ?? raw.m ?? ""),
    time: Number(raw.time ?? 0),
    height: Number(raw.height ?? 0),
    scoreSum: Number(raw.scoreSum ?? 0),
    scoreCnt: Number(raw.scoreCnt ?? 0),
    comments: Number(raw.comments ?? 0),
    images: Array.isArray(raw.images ?? raw.i) ? (raw.images ?? raw.i) : [],
    url: tryDecode(raw.url ?? raw.u ?? ""),
    tags: Array.isArray(raw.tags ?? raw.t) ? (raw.tags ?? raw.t) : [],
    settings: raw.settings ?? raw.s ?? {},
  };
}

export const bastyonRpc = new BastyonRpcService();
```

**Important note on `init()`:** The `init()` method must be called after platform globals are available. The channel store should call `bastyonRpc.init()` lazily on first use, or it can be initialized alongside `AppInitializer` in the auth store's initialization flow.

**Alternative approach:** Instead of creating a new `Api` instance, you can add `getSubscribesChannels` and `getProfileFeed` methods directly to the existing `AppInitializer` class (in `src/app/providers/initializers/app-initializer.ts`), since it already has access to `this.api`. This avoids duplicate initialization. **Use this approach** — add methods to AppInitializer and expose them through the auth store, following the existing pattern for `loadPost`, `loadPostScores`, etc.

**Step 2: Commit**

```bash
git add src/shared/api/bastyon-rpc.ts
git commit -m "feat(channels): add Bastyon RPC service for channels and profile feed"
```

---

### Task 3: Add RPC methods to AppInitializer

**Files:**
- Modify: `src/app/providers/initializers/app-initializer.ts`

**Step 1: Add getSubscribesChannels method**

Add after `checkUserRegistered` method (around line 491), before `waitForApiReady`:

```typescript
  /** Fetch channels the user is subscribed to.
   *  RPC: getsubscribeschannels [address, blockNumber, page, pageSize, 1] */
  async getSubscribesChannels(
    address: string,
    blockNumber: number = 0,
    page: number = 0,
    pageSize: number = 20,
  ): Promise<{ channels: any[]; height: number }> {
    if (!this.api) return { channels: [], height: 0 };
    try {
      await this.initApi();
      await this.waitForApiReady();
      const data = await this.api.rpc("getsubscribeschannels", [
        address, blockNumber, page, pageSize, 1,
      ]);
      // Response: { result: { height, channels: [...] }, error, id } or direct result
      const result = (data as any) ?? {};
      return {
        height: result.height ?? 0,
        channels: result.channels ?? [],
      };
    } catch (e) {
      console.error("[appInit] getSubscribesChannels error:", e);
      return { channels: [], height: 0 };
    }
  }

  /** Fetch posts for a specific channel/user profile.
   *  RPC: getprofilefeed — same parameter format as pocketnet's hierarchical().
   *  Parameters: [height, txid, count, lang, tagsfilter, type, [], [], tagsexcluded, keyword, author] */
  async getProfileFeed(
    authorAddress: string,
    options: { height?: number; startTxid?: string; count?: number } = {},
  ): Promise<any[]> {
    if (!this.api) return [];
    try {
      const params = [
        Number(options.height ?? 0),
        options.startTxid ?? "",
        options.count ?? 10,
        "",   // lang
        [],   // tagsfilter
        [],   // type
        [],   // reserved
        [],   // reserved
        [],   // tagsexcluded
        "",   // keyword
        authorAddress,
      ];
      const data = await this.api.rpc("getprofilefeed", params);
      const items = Array.isArray(data) ? data : (data as any)?.contents ?? [];
      return items;
    } catch (e) {
      console.error("[appInit] getProfileFeed error:", e);
      return [];
    }
  }
```

**Step 2: Expose in auth store**

In `src/entities/auth/model/stores.ts`, add wrapper methods following the existing pattern (where `loadPost`, `loadPostScores` etc. are delegated to `appInitializer`):

```typescript
async getSubscribesChannels(address: string, blockNumber?: number, page?: number, pageSize?: number) {
  return appInitializer.getSubscribesChannels(address, blockNumber, page, pageSize);
},

async getProfileFeed(authorAddress: string, options?: { height?: number; startTxid?: string; count?: number }) {
  return appInitializer.getProfileFeed(authorAddress, options);
},
```

**Step 3: Commit**

```bash
git add src/app/providers/initializers/app-initializer.ts src/entities/auth/model/stores.ts
git commit -m "feat(channels): add getSubscribesChannels and getProfileFeed to AppInitializer"
```

---

### Task 4: Create channel store

**Files:**
- Create: `src/entities/channel/model/channel-store.ts`
- Create: `src/entities/channel/index.ts`

**Step 1: Create channel store**

```typescript
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { useAuthStore } from "@/entities/auth";
import type { Channel, ChannelPost } from "./types";

export const useChannelStore = defineStore("channel", () => {
  const authStore = useAuthStore();

  // --- State ---
  const channels = ref<Channel[]>([]);
  const activeChannelAddress = ref<string | null>(null);
  const posts = ref<Map<string, ChannelPost[]>>(new Map());

  const isLoadingChannels = ref(false);
  const isLoadingPosts = ref(false);
  const channelsPage = ref(0);
  const hasMoreChannels = ref(true);
  const postsStartTxid = ref<Map<string, string>>(new Map());
  const hasMorePosts = ref<Map<string, boolean>>(new Map());
  const blockHeight = ref(0);
  const channelError = ref<string | null>(null);
  const postsError = ref<string | null>(null);

  // --- Getters ---
  const activeChannel = computed(() =>
    channels.value.find(c => c.address === activeChannelAddress.value) ?? null
  );

  const activePosts = computed(() =>
    activeChannelAddress.value ? posts.value.get(activeChannelAddress.value) ?? [] : []
  );

  const activeHasMorePosts = computed(() =>
    activeChannelAddress.value ? hasMorePosts.value.get(activeChannelAddress.value) ?? true : false
  );

  // --- Actions ---

  function tryDecode(val: unknown): string {
    if (typeof val !== "string") return "";
    try { return decodeURIComponent(val); } catch { return val as string; }
  }

  function parsePost(raw: any): ChannelPost {
    return {
      txid: raw.txid ?? "",
      type: raw.type ?? "share",
      caption: tryDecode(raw.caption ?? raw.c ?? ""),
      message: tryDecode(raw.message ?? raw.m ?? ""),
      time: Number(raw.time ?? 0),
      height: Number(raw.height ?? 0),
      scoreSum: Number(raw.scoreSum ?? 0),
      scoreCnt: Number(raw.scoreCnt ?? 0),
      comments: Number(raw.comments ?? 0),
      images: Array.isArray(raw.images ?? raw.i) ? (raw.images ?? raw.i) : [],
      url: tryDecode(raw.url ?? raw.u ?? ""),
      tags: Array.isArray(raw.tags ?? raw.t) ? (raw.tags ?? raw.t) : [],
      settings: raw.settings ?? raw.s ?? {},
    };
  }

  function parseChannel(raw: any): Channel {
    return {
      address: raw.address ?? "",
      name: raw.name ? tryDecode(raw.name) : "",
      avatar: raw.avatar ?? "",
      lastContent: raw.lastContent ? parsePost(raw.lastContent) : null,
    };
  }

  async function fetchChannels(reset = false) {
    const address = authStore.address;
    if (!address) return;
    if (isLoadingChannels.value) return;

    if (reset) {
      channelsPage.value = 0;
      hasMoreChannels.value = true;
      channels.value = [];
    }

    if (!hasMoreChannels.value) return;

    isLoadingChannels.value = true;
    channelError.value = null;

    try {
      const PAGE_SIZE = 20;
      const result = await authStore.getSubscribesChannels(
        address,
        blockHeight.value,
        channelsPage.value,
        PAGE_SIZE,
      );

      if (result.height) blockHeight.value = result.height;

      const parsed = result.channels.map(parseChannel);
      channels.value = reset ? parsed : [...channels.value, ...parsed];
      hasMoreChannels.value = parsed.length >= PAGE_SIZE;
      channelsPage.value++;
    } catch (e) {
      console.error("[channelStore] fetchChannels error:", e);
      channelError.value = "Failed to load channels";
    } finally {
      isLoadingChannels.value = false;
    }
  }

  async function fetchPosts(channelAddress: string, reset = false) {
    if (isLoadingPosts.value) return;

    if (reset) {
      postsStartTxid.value.delete(channelAddress);
      hasMorePosts.value.set(channelAddress, true);
      posts.value.set(channelAddress, []);
    }

    if (!(hasMorePosts.value.get(channelAddress) ?? true)) return;

    isLoadingPosts.value = true;
    postsError.value = null;

    try {
      const COUNT = 10;
      const startTxid = postsStartTxid.value.get(channelAddress) ?? "";

      const rawPosts = await authStore.getProfileFeed(channelAddress, {
        height: blockHeight.value,
        startTxid,
        count: COUNT,
      });

      const parsed = rawPosts.map(parsePost);
      const existing = posts.value.get(channelAddress) ?? [];
      posts.value.set(channelAddress, reset ? parsed : [...existing, ...parsed]);

      if (parsed.length > 0) {
        postsStartTxid.value.set(channelAddress, parsed[parsed.length - 1].txid);
      }
      hasMorePosts.value.set(channelAddress, parsed.length >= COUNT);
    } catch (e) {
      console.error("[channelStore] fetchPosts error:", e);
      postsError.value = "Failed to load posts";
    } finally {
      isLoadingPosts.value = false;
    }
  }

  function setActiveChannel(address: string | null) {
    activeChannelAddress.value = address;
    if (address && !posts.value.has(address)) {
      fetchPosts(address, true);
    }
  }

  function clearActiveChannel() {
    activeChannelAddress.value = null;
  }

  return {
    // State
    channels,
    activeChannelAddress,
    posts,
    isLoadingChannels,
    isLoadingPosts,
    channelError,
    postsError,
    blockHeight,
    hasMoreChannels,

    // Getters
    activeChannel,
    activePosts,
    activeHasMorePosts,

    // Actions
    fetchChannels,
    fetchPosts,
    setActiveChannel,
    clearActiveChannel,
  };
});
```

**Step 2: Create index.ts**

```typescript
export { useChannelStore } from "./model/channel-store";
export type { Channel, ChannelPost } from "./model/types";
```

**Step 3: Commit**

```bash
git add src/entities/channel/
git commit -m "feat(channels): create channel store with fetch and pagination"
```

---

### Task 5: Add i18n translations

**Files:**
- Modify: `src/shared/lib/i18n/locales/en.ts`
- Modify: `src/shared/lib/i18n/locales/ru.ts`

**Step 1: Add English translations**

Add after the `"tabs.invites"` line:

```typescript
  "tabs.channels": "Channels",

  // ── Channels ──
  "channels.noChannels": "No channel subscriptions",
  "channels.noChannelsHint": "Subscribe to channels on Bastyon to see them here",
  "channels.noPosts": "No posts in this channel yet",
  "channels.loadError": "Failed to load channels",
  "channels.postsError": "Failed to load posts",
  "channels.retry": "Retry",
```

**Step 2: Add Russian translations**

Add after the `"tabs.invites"` line:

```typescript
  "tabs.channels": "Каналы",

  // ── Каналы ──
  "channels.noChannels": "Нет подписок на каналы",
  "channels.noChannelsHint": "Подпишитесь на каналы в Bastyon, чтобы видеть их здесь",
  "channels.noPosts": "В этом канале пока нет постов",
  "channels.loadError": "Не удалось загрузить каналы",
  "channels.postsError": "Не удалось загрузить посты",
  "channels.retry": "Повторить",
```

**Step 3: Commit**

```bash
git add src/shared/lib/i18n/locales/en.ts src/shared/lib/i18n/locales/ru.ts
git commit -m "feat(channels): add i18n translations for channels feature"
```

---

### Task 6: Add "Channels" to FolderTabs

**Files:**
- Modify: `src/features/contacts/ui/FolderTabs.vue`

**Step 1: Extend FilterValue type**

Change line 5:
```typescript
// OLD:
type FilterValue = "all" | "personal" | "groups" | "invites";
// NEW:
type FilterValue = "all" | "personal" | "groups" | "invites" | "channels";
```

**Step 2: Add tab to computed list**

Change the `tabs` computed (line 16-21). Add channels after invites:

```typescript
const tabs = computed(() => [
  { value: "all" as const, label: t("tabs.all") },
  { value: "personal" as const, label: t("tabs.personal") },
  { value: "groups" as const, label: t("tabs.groups") },
  { value: "invites" as const, label: t("tabs.invites") },
  { value: "channels" as const, label: t("tabs.channels") },
]);
```

**Step 3: Update visibleTabs filter**

Channels tab should always be visible. Update `visibleTabs` (line 23-25):

```typescript
const visibleTabs = computed(() =>
  tabs.value.filter(t => t.value !== "invites" || chatStore.inviteCount > 0)
);
```

No change needed — channels has no hide condition.

**Step 4: Commit**

```bash
git add src/features/contacts/ui/FolderTabs.vue
git commit -m "feat(channels): add Channels tab to FolderTabs"
```

---

### Task 7: Create ChannelList component

**Files:**
- Create: `src/features/channels/ui/ChannelList.vue`

**Step 1: Create component**

This component follows the same structure as `ContactList.vue` — displays channels as chat-like entries with avatar, name, last post preview, and time.

```vue
<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useChannelStore } from "@/entities/channel";
import type { Channel } from "@/entities/channel";
import { useChatStore } from "@/entities/chat";
import { formatRelativeTime } from "@/shared/lib/format";
import { Avatar } from "@/shared/ui/avatar";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";

const channelStore = useChannelStore();
const chatStore = useChatStore();
const emit = defineEmits<{ selectChannel: [address: string] }>();
const { t } = useI18n();

const scrollerRef = ref<InstanceType<typeof RecycleScroller>>();

onMounted(() => {
  if (channelStore.channels.length === 0) {
    channelStore.fetchChannels(true);
  }
  attachScrollListener();
});

const handleSelect = (channel: Channel) => {
  chatStore.setActiveRoom(null as any); // deselect chat room
  channelStore.setActiveChannel(channel.address);
  emit("selectChannel", channel.address);
};

const getPreviewText = (channel: Channel): string => {
  if (!channel.lastContent) return t("channels.noPosts");
  const { caption, message } = channel.lastContent;
  const text = caption || message || "";
  return text.length > 100 ? text.slice(0, 100) + "…" : text;
};

const getPreviewTime = (channel: Channel): string => {
  if (!channel.lastContent?.time) return "";
  return formatRelativeTime(new Date(channel.lastContent.time * 1000));
};

// Infinite scroll
let scrollEl: HTMLElement | null = null;

const onScroll = () => {
  const el = scrollerRef.value?.$el as HTMLElement | undefined;
  if (!el || !channelStore.hasMoreChannels || channelStore.isLoadingChannels) return;
  const { scrollTop, scrollHeight, clientHeight } = el;
  if (scrollHeight - scrollTop - clientHeight < 200) {
    channelStore.fetchChannels();
  }
};

const attachScrollListener = () => {
  if (scrollEl) scrollEl.removeEventListener("scroll", onScroll);
  scrollEl = (scrollerRef.value?.$el as HTMLElement) ?? null;
  scrollEl?.addEventListener("scroll", onScroll, { passive: true });
};

watch(scrollerRef, attachScrollListener);
onUnmounted(() => { scrollEl?.removeEventListener("scroll", onScroll); });
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Loading state -->
    <div v-if="channelStore.isLoadingChannels && channelStore.channels.length === 0"
      class="flex flex-1 items-center justify-center">
      <div class="h-6 w-6 animate-spin rounded-full border-2 border-color-bg-ac border-t-transparent" />
    </div>

    <!-- Error state -->
    <div v-else-if="channelStore.channelError && channelStore.channels.length === 0"
      class="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <p class="text-sm text-text-on-main-bg-color">{{ t("channels.loadError") }}</p>
      <button
        class="rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-white"
        @click="channelStore.fetchChannels(true)"
      >
        {{ t("channels.retry") }}
      </button>
    </div>

    <!-- Empty state -->
    <div v-else-if="channelStore.channels.length === 0"
      class="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div class="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-grad-0">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-text-on-main-bg-color">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      </div>
      <p class="text-sm text-text-on-main-bg-color">{{ t("channels.noChannels") }}</p>
      <p class="text-xs text-text-on-main-bg-color/60">{{ t("channels.noChannelsHint") }}</p>
    </div>

    <!-- Channel list -->
    <RecycleScroller
      v-else
      ref="scrollerRef"
      :items="channelStore.channels"
      :item-size="68"
      key-field="address"
      class="h-full"
    >
      <template #default="{ item: channel }">
        <button
          class="flex h-[68px] w-full cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-grad-0 active:bg-neutral-grad-0"
          :class="channel.address === channelStore.activeChannelAddress ? 'bg-color-bg-ac/10' : ''"
          @click="handleSelect(channel)"
        >
          <!-- Avatar -->
          <div class="relative shrink-0">
            <Avatar :src="channel.avatar" :name="channel.name" size="md" />
            <!-- Channel indicator (megaphone) -->
            <div class="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-background-total-theme">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" class="text-text-on-main-bg-color">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
            </div>
          </div>

          <div class="min-w-0 flex-1">
            <!-- Name + time -->
            <div class="flex items-center justify-between gap-2">
              <span class="truncate text-[15px] font-medium text-text-color">
                {{ channel.name }}
              </span>
              <span v-if="channel.lastContent" class="shrink-0 text-xs text-text-on-main-bg-color">
                {{ getPreviewTime(channel) }}
              </span>
            </div>
            <!-- Last post preview -->
            <div class="mt-0.5 flex items-center justify-between gap-2">
              <span class="truncate text-sm text-text-on-main-bg-color">
                {{ getPreviewText(channel) }}
              </span>
            </div>
          </div>
        </button>
      </template>
    </RecycleScroller>

    <!-- Loading more indicator -->
    <div v-if="channelStore.isLoadingChannels && channelStore.channels.length > 0"
      class="flex justify-center py-2">
      <div class="h-5 w-5 animate-spin rounded-full border-2 border-color-bg-ac border-t-transparent" />
    </div>
  </div>
</template>
```

**Step 2: Commit**

```bash
git add src/features/channels/ui/ChannelList.vue
git commit -m "feat(channels): create ChannelList component with virtual scroll"
```

---

### Task 8: Create ChannelPostBubble component

**Files:**
- Create: `src/features/channels/ui/ChannelPostBubble.vue`

**Step 1: Create component**

Renders a single channel post as a chat message bubble (left-aligned incoming message style). Supports text, images, video preview, and action bar (scores, comments).

```vue
<script setup lang="ts">
import { ref, computed } from "vue";
import type { ChannelPost } from "@/entities/channel";
import { formatRelativeTime } from "@/shared/lib/format";
import { useAuthStore } from "@/entities/auth";

interface Props {
  post: ChannelPost
  channelName?: string
}

const props = defineProps<Props>();
const emit = defineEmits<{
  openPost: [txid: string]
  openComments: [txid: string]
}>();

const authStore = useAuthStore();

const formattedTime = computed(() =>
  formatRelativeTime(new Date(props.post.time * 1000))
);

/** Check if the message is an article (EditorJS JSON) */
const isArticle = computed(() =>
  props.post.type === "article" || props.post.settings?.v === "a"
);

/** Extract plain text from EditorJS JSON for article preview */
const articlePreview = computed(() => {
  if (!isArticle.value) return "";
  try {
    const parsed = JSON.parse(props.post.message);
    const blocks = parsed?.blocks ?? [];
    return blocks
      .filter((b: any) => b.type === "paragraph")
      .map((b: any) => {
        const text = b.data?.text ?? "";
        // Strip HTML tags
        return text.replace(/<[^>]*>/g, "");
      })
      .join("\n")
      .slice(0, 500);
  } catch {
    return props.post.message;
  }
});

const displayMessage = computed(() =>
  isArticle.value ? articlePreview.value : props.post.message
);

const hasImages = computed(() =>
  (props.post.images?.length ?? 0) > 0
);
</script>

<template>
  <div class="flex w-full px-3 py-1.5">
    <div
      class="max-w-[85%] cursor-pointer rounded-2xl rounded-tl-sm bg-neutral-grad-0 px-3 py-2 transition-colors hover:bg-neutral-grad-0/80"
      @click="emit('openPost', post.txid)"
    >
      <!-- Caption (title) -->
      <p v-if="post.caption" class="mb-1 text-sm font-semibold text-text-color">
        {{ post.caption }}
      </p>

      <!-- Images -->
      <div v-if="hasImages" class="mb-2">
        <div
          v-if="post.images!.length === 1"
          class="overflow-hidden rounded-lg"
        >
          <img
            :src="post.images![0]"
            class="max-h-60 w-full object-cover"
            loading="lazy"
          />
        </div>
        <div v-else class="grid grid-cols-2 gap-1 overflow-hidden rounded-lg">
          <img
            v-for="(img, idx) in post.images!.slice(0, 4)"
            :key="idx"
            :src="img"
            class="h-32 w-full object-cover"
            loading="lazy"
          />
        </div>
      </div>

      <!-- Video indicator -->
      <div v-if="post.type === 'video' && !hasImages" class="mb-2 flex items-center gap-2 rounded-lg bg-black/5 px-3 py-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="text-color-bg-ac">
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
        <span class="text-xs text-text-on-main-bg-color">Video</span>
      </div>

      <!-- Article badge -->
      <div v-if="isArticle" class="mb-1 flex items-center gap-1">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-color-bg-ac">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
        <span class="text-[10px] font-medium uppercase text-color-bg-ac">Article</span>
      </div>

      <!-- Message text -->
      <p v-if="displayMessage" class="whitespace-pre-wrap break-words text-sm text-text-color">
        {{ displayMessage }}
      </p>

      <!-- Footer: time + stats -->
      <div class="mt-1.5 flex items-center gap-3 text-[11px] text-text-on-main-bg-color">
        <span>{{ formattedTime }}</span>

        <!-- Rating -->
        <button
          v-if="post.scoreCnt > 0"
          class="flex items-center gap-0.5 transition-colors hover:text-color-bg-ac"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
          </svg>
          {{ post.scoreSum }}
        </button>

        <!-- Comments -->
        <button
          v-if="post.comments > 0"
          class="flex items-center gap-0.5 transition-colors hover:text-color-bg-ac"
          @click.stop="emit('openComments', post.txid)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          {{ post.comments }}
        </button>
      </div>
    </div>
  </div>
</template>
```

**Step 2: Commit**

```bash
git add src/features/channels/ui/ChannelPostBubble.vue
git commit -m "feat(channels): create ChannelPostBubble component"
```

---

### Task 9: Create ChannelView component

**Files:**
- Create: `src/features/channels/ui/ChannelView.vue`

**Step 1: Create component**

Displays the channel's post feed in a chat-like layout (scrollable, newest at bottom). Header shows channel info. Posts rendered via ChannelPostBubble. Supports infinite scroll for older posts (scroll up to load more).

```vue
<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { useChannelStore } from "@/entities/channel";
import { Avatar } from "@/shared/ui/avatar";
import ChannelPostBubble from "./ChannelPostBubble.vue";
import PostPlayerModal from "@/features/post-player/ui/PostPlayerModal.vue";

const channelStore = useChannelStore();
const emit = defineEmits<{ back: [] }>();
const { t } = useI18n();

const scrollContainer = ref<HTMLElement>();
const showPostModal = ref(false);
const selectedTxid = ref("");

const channel = computed(() => channelStore.activeChannel);
const posts = computed(() => channelStore.activePosts);

// Reverse posts so newest are at the bottom (chat order)
const sortedPosts = computed(() => [...posts.value].reverse());

// Scroll to bottom on initial load
watch(
  () => posts.value.length,
  (newLen, oldLen) => {
    if (oldLen === 0 && newLen > 0) {
      nextTick(() => {
        scrollContainer.value?.scrollTo({ top: scrollContainer.value.scrollHeight });
      });
    }
  },
);

// Load more posts on scroll to top
const onScroll = () => {
  const el = scrollContainer.value;
  if (!el) return;
  if (el.scrollTop < 200 && !channelStore.isLoadingPosts && channelStore.activeHasMorePosts) {
    const oldHeight = el.scrollHeight;
    const addr = channelStore.activeChannelAddress;
    if (addr) {
      channelStore.fetchPosts(addr).then(() => {
        // Preserve scroll position after prepending older posts
        nextTick(() => {
          const newHeight = el.scrollHeight;
          el.scrollTop = newHeight - oldHeight;
        });
      });
    }
  }
};

const openPost = (txid: string) => {
  selectedTxid.value = txid;
  showPostModal.value = true;
};

const openComments = (txid: string) => {
  selectedTxid.value = txid;
  showPostModal.value = true;
};

onMounted(() => {
  scrollContainer.value?.addEventListener("scroll", onScroll, { passive: true });
});

onUnmounted(() => {
  scrollContainer.value?.removeEventListener("scroll", onScroll);
});
</script>

<template>
  <div v-if="channel" class="flex h-full flex-col">
    <!-- Header -->
    <div class="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-grad-0 px-3">
      <button
        class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0 md:hidden"
        @click="emit('back')"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
        </svg>
      </button>

      <Avatar :src="channel.avatar" :name="channel.name" size="sm" />
      <div class="min-w-0 flex-1">
        <div class="truncate text-[15px] font-medium text-text-color">
          {{ channel.name }}
        </div>
        <div class="text-xs text-text-on-main-bg-color">
          {{ t("tabs.channels") }}
        </div>
      </div>
    </div>

    <!-- Posts area -->
    <div ref="scrollContainer" class="flex-1 overflow-y-auto">
      <!-- Loading spinner (top) -->
      <div v-if="channelStore.isLoadingPosts" class="flex justify-center py-3">
        <div class="h-5 w-5 animate-spin rounded-full border-2 border-color-bg-ac border-t-transparent" />
      </div>

      <!-- Error -->
      <div v-if="channelStore.postsError && posts.length === 0"
        class="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <p class="text-sm text-text-on-main-bg-color">{{ t("channels.postsError") }}</p>
        <button
          class="rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-white"
          @click="channelStore.fetchPosts(channel!.address, true)"
        >
          {{ t("channels.retry") }}
        </button>
      </div>

      <!-- Empty -->
      <div v-else-if="!channelStore.isLoadingPosts && posts.length === 0"
        class="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <p class="text-sm text-text-on-main-bg-color">{{ t("channels.noPosts") }}</p>
      </div>

      <!-- Posts -->
      <div v-else class="py-2">
        <ChannelPostBubble
          v-for="post in sortedPosts"
          :key="post.txid"
          :post="post"
          :channel-name="channel.name"
          @open-post="openPost"
          @open-comments="openComments"
        />
      </div>
    </div>

    <!-- Post modal -->
    <PostPlayerModal
      v-if="showPostModal"
      :txid="selectedTxid"
      @close="showPostModal = false"
    />
  </div>
</template>
```

**Step 2: Commit**

```bash
git add src/features/channels/ui/ChannelView.vue
git commit -m "feat(channels): create ChannelView with post feed and scroll"
```

---

### Task 10: Create channels feature index

**Files:**
- Create: `src/features/channels/index.ts`

**Step 1: Create index**

```typescript
export { default as ChannelList } from "./ui/ChannelList.vue";
export { default as ChannelView } from "./ui/ChannelView.vue";
export { default as ChannelPostBubble } from "./ui/ChannelPostBubble.vue";
```

**Step 2: Commit**

```bash
git add src/features/channels/index.ts
git commit -m "feat(channels): export channel feature components"
```

---

### Task 11: Integrate ChannelList into ChatSidebar

**Files:**
- Modify: `src/widgets/sidebar/ChatSidebar.vue`
- Modify: `src/features/contacts/ui/ContactList.vue`

**Step 1: Update activeFilter type in ChatSidebar**

In `ChatSidebar.vue`, change line 32:

```typescript
// OLD:
const activeFilter = ref<"all" | "personal" | "groups" | "invites">("all");
// NEW:
const activeFilter = ref<"all" | "personal" | "groups" | "invites" | "channels">("all");
```

Update `tabOrder` on line 33:

```typescript
// OLD:
const tabOrder = ["all", "personal", "groups", "invites"] as const;
// NEW:
const tabOrder = ["all", "personal", "groups", "invites", "channels"] as const;
```

**Step 2: Import ChannelList and channel store**

Add to imports at top of ChatSidebar.vue:

```typescript
import { ChannelList } from "@/features/channels";
import { useChannelStore } from "@/entities/channel";
```

Add to setup:

```typescript
const channelStore = useChannelStore();
```

**Step 3: Conditional render — show ChannelList when filter is "channels"**

Replace the section around lines 222-234 (the `<template v-else>` block with FolderTabs + ContactList):

```vue
<template v-else>
  <FolderTabs v-model="activeFilter" />
  <div class="relative flex-1 overflow-hidden">
    <RoomListSkeleton v-if="roomsLoading && activeFilter !== 'channels'" :first-load="true" />
    <transition v-else :name="'tab-slide-' + slideDirection">
      <ChannelList
        v-if="activeFilter === 'channels'"
        key="channels"
        class="absolute inset-0 overflow-y-auto"
        @select-channel="handleSelectRoom"
      />
      <ContactList
        v-else
        :key="activeFilter"
        :filter="activeFilter"
        class="absolute inset-0 overflow-y-auto"
        @select-room="handleSelectRoom"
      />
    </transition>
  </div>
</template>
```

**Step 4: Update ContactList filter prop type**

In `ContactList.vue`, line 23, update the Props interface:

```typescript
// OLD:
interface Props {
  filter?: "all" | "personal" | "groups" | "invites";
}
// NEW:
interface Props {
  filter?: "all" | "personal" | "groups" | "invites" | "channels";
}
```

This ensures TypeScript is happy, even though ContactList won't actually receive "channels" (it's handled by ChannelList).

**Step 5: Merge channels into "All" tab in ContactList**

In `ContactList.vue`, add channel integration for the "All" filter. Import channel store at top:

```typescript
import { useChannelStore } from "@/entities/channel";
```

In setup:

```typescript
const channelStore = useChannelStore();
```

For the "All" tab merge, we need to create a unified list. This is the most complex part. In `allFilteredRooms` computed (line 154-163), when filter is "all", we need to interleave channel entries by time. The approach: create a wrapper type that can hold either a room or a channel, sorted by timestamp.

**Simplified approach for "All" tab:** Add a computed that merges channels as "virtual room" entries into the filtered list. Each channel gets a synthetic ID like `channel:ADDRESS` so RecycleScroller can use it as a key.

Add before `allFilteredRooms`:

```typescript
// Channels as chat-list-compatible items for "All" tab merge
const channelAsItems = computed(() => {
  return channelStore.channels.map(ch => ({
    id: `channel:${ch.address}`,
    isChannel: true as const,
    channel: ch,
    sortTime: ch.lastContent?.time ? ch.lastContent.time * 1000 : 0,
  }));
});
```

**Important:** The "All" tab merge is complex because ContactList currently renders `ChatRoom` objects via RecycleScroller. Mixing two different item types requires either:
a) A union type with conditional rendering in the template, or
b) Rendering channels in a separate section.

**Recommendation for v1:** Keep it simple — in the "All" tab, show channels in a separate section at the bottom of the list (after chat rooms), with a "Channels" divider. Full chronological merge can be done in v2.

Actually, since the user explicitly asked for channels to be "combined in the All tab by time as if messages are being written", we should implement the merge properly.

**The merge strategy:** Create a wrapper type and modify the RecycleScroller to handle both types.

This will be detailed in the task but the key changes are:
1. Create a `ListItem` union type: `{ type: 'room', room: ChatRoom } | { type: 'channel', channel: Channel }`
2. Computed `mergedItems` that combines and sorts both by last activity time
3. Template uses `v-if` on item type to render either room row or channel row

**Step 6: Commit**

```bash
git add src/widgets/sidebar/ChatSidebar.vue src/features/contacts/ui/ContactList.vue
git commit -m "feat(channels): integrate ChannelList in sidebar with All tab merge"
```

---

### Task 12: Integrate ChannelView into ChatWindow

**Files:**
- Modify: `src/widgets/chat-window/ChatWindow.vue`

**Step 1: Import channel components and store**

Add to imports:

```typescript
import { ChannelView } from "@/features/channels";
import { useChannelStore } from "@/entities/channel";
```

Add to setup:

```typescript
const channelStore = useChannelStore();
```

**Step 2: Add computed for active view type**

```typescript
const isChannelView = computed(() => channelStore.activeChannelAddress !== null);
```

**Step 3: Modify template**

After the "No room selected" div (line 302-315), and before "Active room content" (line 318), add channel view:

```vue
<!-- Active channel view -->
<template v-if="isChannelView">
  <ChannelView @back="() => { channelStore.clearActiveChannel(); emit('back'); }" />
</template>

<!-- No room selected (only show when no channel either) -->
<div
  v-else-if="!chatStore.activeRoom"
  class="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center text-text-on-main-bg-color"
>
  <!-- ... existing empty state ... -->
</div>
```

**Step 4: Ensure mutual exclusion**

When a chat room is selected, clear active channel (and vice versa). Add a watch:

```typescript
// Mutual exclusion: channel vs chat room
watch(() => chatStore.activeRoomId, (roomId) => {
  if (roomId) channelStore.clearActiveChannel();
});
```

The channel store's `setActiveChannel` already handles the reverse (clearing active room is done in ChannelList's `handleSelect`).

**Step 5: Commit**

```bash
git add src/widgets/chat-window/ChatWindow.vue
git commit -m "feat(channels): integrate ChannelView in ChatWindow with mutual exclusion"
```

---

### Task 13: Load channels on auth

**Files:**
- Modify: `src/entities/auth/model/stores.ts` (or wherever Matrix/app initialization happens)

**Step 1: Trigger channel fetch after login**

After the user is authenticated and the app initializer is ready, fetch channels. Find where `initializeAndFetchUserData` is called and add channel loading afterward.

Look for the initialization flow (likely in auth store or an app-level watcher). Add:

```typescript
// After auth is confirmed:
const channelStore = useChannelStore();
channelStore.fetchChannels(true);
```

**Step 2: Commit**

```bash
git add src/entities/auth/model/stores.ts
git commit -m "feat(channels): auto-load channels on user authentication"
```

---

### Task 14: End-to-end verification

**Step 1: Run dev server**

```bash
npm run dev
```

**Step 2: Manual verification checklist**

1. Login to the app
2. Verify "Channels" tab appears in FolderTabs
3. Click "Channels" — verify channel list loads
4. Verify each channel shows: avatar, name, last post preview, relative time
5. Click a channel — verify ChatWindow switches to ChannelView
6. Verify posts load as message bubbles
7. Scroll up in channel — verify older posts load (pagination)
8. Click back to "All" tab — verify channels appear mixed with chats
9. Switch between a channel and a regular chat — verify mutual exclusion works
10. Test empty/error states
11. Test with no network — verify error state appears

**Step 3: Fix any issues found**

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(channels): complete Bastyon channels integration"
```
