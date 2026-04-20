<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, watch } from "vue";
import { useChannelStore } from "@/entities/channel";
import type { Channel } from "@/entities/channel";
import { useChatStore } from "@/entities/chat";
import { formatRelativeTime } from "@/shared/lib/format";
import Avatar from "@/shared/ui/avatar/Avatar.vue";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";

const channelStore = useChannelStore();
const chatStore = useChatStore();
const { t } = useI18n();

const emit = defineEmits<{ selectChannel: [address: string] }>();

const scrollerRef = ref<InstanceType<typeof RecycleScroller>>();

onMounted(() => {
  if (channelStore.channels.length === 0) {
    channelStore.fetchChannels(true).then(() => nextTick(prefetchVisiblePosts));
  } else {
    nextTick(prefetchVisiblePosts);
  }
  attachScrollListener();
});

const handleSelect = (channel: Channel) => {
  channelStore.setActiveChannel(channel.address);
  chatStore.setActiveRoom(null);
  emit("selectChannel", channel.address);
};

const getPreviewText = (channel: Channel): string => {
  if (!channel.lastContent) return "";
  const text = channel.lastContent.caption || channel.lastContent.message || "";
  return text.length > 80 ? text.slice(0, 80) + "..." : text;
};

const getPreviewTime = (channel: Channel): string => {
  if (!channel.lastContent) return "";
  return formatRelativeTime(new Date(channel.lastContent.time * 1000));
};

// Scroll handling for infinite load + prefetch visible channels' posts
const ITEM_HEIGHT = 68;
const PREFETCH_BUFFER = 3;
let scrollEl: HTMLElement | null = null;
let prefetchTimer: ReturnType<typeof setTimeout> | null = null;

/** Prefetch posts for channels visible in viewport (+ buffer) */
const prefetchVisiblePosts = () => {
  const el = scrollerRef.value?.$el as HTMLElement | undefined;
  if (!el) return;
  const { scrollTop, clientHeight } = el;
  const firstIdx = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 1);
  const lastIdx = Math.min(
    channelStore.channels.length - 1,
    Math.ceil((scrollTop + clientHeight) / ITEM_HEIGHT) + PREFETCH_BUFFER,
  );
  for (let i = firstIdx; i <= lastIdx; i++) {
    const addr = channelStore.channels[i]?.address;
    if (addr && !channelStore.posts.has(addr)) {
      channelStore.fetchPosts(addr, true);
    }
  }
};

const schedulePrefetch = () => {
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(prefetchVisiblePosts, 300);
};

const onScroll = () => {
  const el = scrollerRef.value?.$el as HTMLElement | undefined;
  if (!el) return;
  const { scrollTop, scrollHeight, clientHeight } = el;
  if (
    scrollHeight - scrollTop - clientHeight < 200 &&
    channelStore.hasMoreChannels &&
    !channelStore.isLoadingChannels
  ) {
    channelStore.fetchChannels();
  }
  schedulePrefetch();
};

const attachScrollListener = () => {
  if (scrollEl) scrollEl.removeEventListener("scroll", onScroll);
  scrollEl = (scrollerRef.value?.$el as HTMLElement) ?? null;
  scrollEl?.addEventListener("scroll", onScroll, { passive: true });
};

watch(scrollerRef, attachScrollListener);
onUnmounted(() => {
  scrollEl?.removeEventListener("scroll", onScroll);
  if (prefetchTimer) clearTimeout(prefetchTimer);
});
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Loading skeleton (same as RoomListSkeleton) -->
    <div
      v-if="channelStore.isLoadingChannels && channelStore.channels.length === 0"
      class="space-y-1"
    >
      <div v-for="i in 6" :key="i" class="flex items-center gap-3 px-3 py-2.5">
        <div class="h-10 w-10 shrink-0 animate-pulse rounded-full bg-neutral-grad-2" />
        <div class="min-w-0 flex-1 space-y-1.5">
          <div class="h-3.5 w-24 animate-pulse rounded bg-neutral-grad-2" />
          <div
            class="h-3 animate-pulse rounded bg-neutral-grad-2"
            :style="{ width: `${100 + (i * 29) % 80}px` }"
          />
        </div>
        <div class="h-3 w-8 animate-pulse rounded bg-neutral-grad-2" />
      </div>
    </div>

    <!-- Error state -->
    <div
      v-else-if="channelStore.channelError && channelStore.channels.length === 0"
      class="flex flex-col items-center gap-3 px-6 py-12 text-center"
    >
      <p class="text-sm text-color-bad">{{ t("channels.loadError") }}</p>
      <button
        class="rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-color-bg-ac/90"
        @click="channelStore.fetchChannels(true)"
      >
        {{ t("channels.retry") }}
      </button>
    </div>

    <!-- Empty state -->
    <div
      v-else-if="channelStore.channels.length === 0 && !channelStore.isLoadingChannels"
      class="flex flex-col items-center gap-3 px-6 py-12 text-center"
    >
      <div class="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-grad-0">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-text-on-main-bg-color">
          <path d="M19 11a7 7 0 0 1-7 7m0 0a7 7 0 0 1-7-7m7 7v4m-4-1h8" />
          <path d="M12 4a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3z" />
        </svg>
      </div>
      <p class="text-sm text-text-on-main-bg-color">{{ t("channels.noChannels") }}</p>
      <p class="text-xs text-text-on-main-bg-color/60">{{ t("channels.noChannelsHint") }}</p>
    </div>

    <!-- Channel list -->
    <RecycleScroller
      v-if="channelStore.channels.length > 0"
      ref="scrollerRef"
      :items="channelStore.channels"
      :item-size="ITEM_HEIGHT"
      :style="{ '--recycle-item-size': `${ITEM_HEIGHT}px` }"
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
            <!-- Channel (megaphone) indicator -->
            <div
              class="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-background-total-theme"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" class="text-text-on-main-bg-color">
                <path d="M3 10v4a1 1 0 0 0 1 1h2l5 4V5L6 9H4a1 1 0 0 0-1 1zm16 2a6 6 0 0 0-3-5.2v10.4A6 6 0 0 0 19 12z" />
              </svg>
            </div>
          </div>

          <div class="min-w-0 flex-1">
            <!-- Name row -->
            <div class="flex items-center justify-between gap-2">
              <span class="truncate text-[15px] font-medium text-text-color">
                {{ channel.name }}
              </span>
              <span
                v-if="channel.lastContent"
                class="flex shrink-0 items-center gap-0.5 text-xs text-text-on-main-bg-color"
              >
                {{ getPreviewTime(channel) }}
              </span>
            </div>

            <!-- Preview row -->
            <div class="mt-0.5 flex items-center justify-between gap-2">
              <span class="truncate text-sm text-text-on-main-bg-color">
                {{ getPreviewText(channel) }}
              </span>
            </div>
          </div>
        </button>
      </template>
    </RecycleScroller>

    <!-- Loading more spinner -->
    <div
      v-if="channelStore.isLoadingChannels && channelStore.channels.length > 0"
      class="flex justify-center py-3"
    >
      <div class="contain-strict h-5 w-5 animate-spin rounded-full border-2 border-color-bg-ac border-t-transparent" />
    </div>
  </div>
</template>
