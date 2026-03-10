<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useChannelStore } from "@/entities/channel";
import { useAuthStore } from "@/entities/auth";
import { useToast } from "@/shared/lib/use-toast";
import { formatDate } from "@/shared/lib/format";
import Avatar from "@/shared/ui/avatar/Avatar.vue";
import { PostCard } from "@/features/post-player";
import SharePostPicker from "@/features/post-player/ui/SharePostPicker.vue";
import ContextMenu from "@/shared/ui/context-menu/ContextMenu.vue";
import type { ContextMenuItem } from "@/shared/ui/context-menu/ContextMenu.vue";
import ChannelInfoPanel from "./ChannelInfoPanel.vue";

const emit = defineEmits<{ back: [] }>();
const { t } = useI18n();

const channelStore = useChannelStore();
const authStore = useAuthStore();
const { toast } = useToast();

const scrollContainerRef = ref<HTMLElement>();
const showChannelInfo = ref(false);

const activeChannel = computed(() => channelStore.activeChannel);
const posts = computed(() => channelStore.activePosts);

/* ── Post entrance animation (same pattern as MessageList) ── */
const recentPostIds = ref(new Set<string>());
let prevPostLen: number | undefined;

watch(
  () => posts.value.length,
  (newLen, oldLen) => {
    if (loadingMore || oldLen === undefined) { prevPostLen = newLen; return; }
    const delta = newLen - (prevPostLen ?? 0);
    if (delta <= 0 || delta > 10) { prevPostLen = newLen; return; }
    // Mark newly prepended posts (newest-first, so new ones are at index 0)
    const newIds = posts.value.slice(0, delta).map(p => p.txid);
    for (const id of newIds) recentPostIds.value.add(id);
    setTimeout(() => {
      for (const id of newIds) recentPostIds.value.delete(id);
    }, 350);
    prevPostLen = newLen;
  },
);

function getPostEnterClass(txid: string): string {
  return recentPostIds.value.has(txid) ? "msg-enter-other" : "";
}

const isLoading = computed(() => channelStore.isLoadingPosts);
const hasMore = computed(() => channelStore.activeHasMorePosts);
const error = computed(() => channelStore.postsError);

/** Posts in chronological order (oldest first) for column-reverse display.
 *  column-reverse reverses visual order, so we feed newest-first
 *  and it displays oldest-at-top, newest-at-bottom. */
interface DisplayItem {
  id: string;
  type: "post" | "date-separator";
  txid?: string;
  label?: string;
  time?: number;
}

function getDateLabel(ts: number, nextTs?: number): string | null {
  const d = new Date(ts * 1000);
  const nd = nextTs ? new Date(nextTs * 1000) : null;
  if (nd && d.toDateString() === nd.toDateString()) return null;
  return formatDate(d);
}

/** Build items in newest-first order (column-reverse will flip visually) */
const displayItems = computed<DisplayItem[]>(() => {
  const sorted = posts.value; // already newest-first from store
  const items: DisplayItem[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const post = sorted[i];
    items.push({ id: post.txid, type: "post", txid: post.txid, time: post.time });

    // Date separator: compare with next post (older)
    const nextPost = sorted[i + 1];
    const dateLabel = getDateLabel(post.time, nextPost?.time);
    if (dateLabel) {
      items.push({ id: `date-${post.txid}`, type: "date-separator", label: dateLabel });
    }
  }

  return items;
});

/* ── Infinite scroll upward (load older posts) ── */
let loadingMore = false;

function onScroll() {
  const el = scrollContainerRef.value;
  if (!el || loadingMore) return;

  // column-reverse: scrollTop is negative, scrolling "up" means towards 0
  // When user scrolls to visual top (oldest posts), load more
  const scrollBottom = el.scrollHeight + el.scrollTop - el.clientHeight;
  if (scrollBottom < 200 && hasMore.value && !isLoading.value && channelStore.activeChannelAddress) {
    loadingMore = true;
    channelStore.fetchPosts(channelStore.activeChannelAddress).finally(() => {
      loadingMore = false;
    });
  }
}

onMounted(() => {
  scrollContainerRef.value?.addEventListener("scroll", onScroll, { passive: true });
});
onUnmounted(() => {
  scrollContainerRef.value?.removeEventListener("scroll", onScroll);
});

/* ── Context menu (same icon style as MessageContextMenu) ── */
const ctxMenu = ref({ show: false, x: 0, y: 0, txid: "" });
const showSharePicker = ref(false);
const sharePostTxid = ref("");

const svg = (d: string) =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICONS = {
  forward: svg('<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>'),
  copy:    svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  link:    svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
};

const ctxMenuItems = computed<ContextMenuItem[]>(() => [
  { label: t("contextMenu.forward"), icon: ICONS.forward, action: "forward" },
  { label: t("contextMenu.copy"),    icon: ICONS.copy,    action: "copy" },
  { label: t("contextMenu.copyLink"),icon: ICONS.link,    action: "copyLink" },
]);

function onPostContextMenu(e: MouseEvent, txid: string) {
  e.preventDefault();
  ctxMenu.value = { show: true, x: e.clientX, y: e.clientY, txid };
}

function onCtxMenuSelect(action: string) {
  const txid = ctxMenu.value.txid;
  ctxMenu.value.show = false;

  if (action === "forward") {
    sharePostTxid.value = txid;
    showSharePicker.value = true;
  } else if (action === "copy") {
    authStore.loadPost(txid).then((p) => {
      if (p) {
        const text = [p.caption, p.message].filter(Boolean).join("\n\n");
        navigator.clipboard.writeText(text).then(() => toast(t("chat.copiedToClipboard")));
      }
    });
  } else if (action === "copyLink") {
    navigator.clipboard.writeText(`bastyon://post?s=${txid}`).then(() => toast(t("chat.copiedToClipboard")));
  }
}
</script>

<template>
  <div class="flex h-full flex-col bg-background-total-theme">
    <!-- Header -->
    <div class="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-grad-0 px-3">
      <button
        class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0 md:hidden"
        :aria-label="t('nav.back')"
        @click="emit('back')"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
        </svg>
      </button>

      <button
        v-if="activeChannel"
        class="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
        @click="showChannelInfo = true"
      >
        <Avatar
          :src="activeChannel.avatar"
          :name="activeChannel.name"
          size="sm"
        />
        <div class="min-w-0 flex-1">
          <div class="truncate text-[15px] font-medium text-text-color">
            {{ activeChannel.name }}
          </div>
          <div class="text-xs text-text-on-main-bg-color">{{ t("tabs.channels") }}</div>
        </div>
      </button>
    </div>

    <!-- Loading skeleton -->
    <div
      v-if="isLoading && posts.length === 0"
      class="flex-1 space-y-3 px-4 py-3"
    >
      <div v-for="i in 5" :key="i" class="mx-auto max-w-6xl">
        <div class="flex gap-2" :class="i % 3 === 0 ? 'flex-row-reverse' : 'flex-row'">
          <div v-if="i % 3 !== 0" class="h-8 w-8 shrink-0 animate-pulse rounded-full bg-neutral-grad-2" />
          <div
            class="h-8 animate-pulse rounded-2xl bg-neutral-grad-2"
            :style="{ width: `${120 + (i * 37) % 100}px` }"
          />
        </div>
      </div>
    </div>

    <!-- Error state -->
    <div
      v-else-if="error && posts.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <p class="text-sm text-color-bad">{{ error }}</p>
      <button
        v-if="channelStore.activeChannelAddress"
        class="rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-color-bg-ac/90"
        @click="channelStore.fetchPosts(channelStore.activeChannelAddress!, true)"
      >
        {{ t("channels.retry") }}
      </button>
    </div>

    <!-- Empty state -->
    <div
      v-else-if="posts.length === 0 && !isLoading"
      class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <div class="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-grad-0">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-text-on-main-bg-color">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <p class="text-sm text-text-on-main-bg-color">{{ t("channels.noPosts") }}</p>
    </div>

    <!-- Posts list: column-reverse = naturally scrolled to bottom, no jumping -->
    <div
      v-else
      ref="scrollContainerRef"
      class="flex flex-1 flex-col-reverse overflow-y-auto px-4"
    >
      <template v-for="item in displayItems" :key="item.id">
        <!-- Date separator -->
        <div
          v-if="item.type === 'date-separator'"
          class="mx-auto max-w-6xl"
        >
          <div class="flex justify-center py-3">
            <span class="rounded-full bg-neutral-grad-0/80 px-3 py-1 text-xs font-medium text-text-on-main-bg-color">
              {{ item.label }}
            </span>
          </div>
        </div>

        <!-- Post card (same layout as MessageList: mx-auto max-w-6xl wrapper) -->
        <div
          v-else-if="item.type === 'post' && item.txid"
          :class="getPostEnterClass(item.txid!)"
          @contextmenu="onPostContextMenu($event, item.txid!)"
        >
          <div class="mx-auto max-w-6xl py-1">
            <PostCard :txid="item.txid" :is-own="false" />
          </div>
        </div>
      </template>

      <!-- Load-more spinner at visual top -->
      <div
        v-if="isLoading && posts.length > 0"
        class="flex justify-center py-3"
      >
        <div class="h-5 w-5 animate-spin rounded-full border-2 border-color-bg-ac border-t-transparent" />
      </div>
    </div>

    <!-- Context menu -->
    <ContextMenu
      :show="ctxMenu.show"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxMenuItems"
      @close="ctxMenu.show = false"
      @select="onCtxMenuSelect"
    />

    <!-- Share post picker -->
    <SharePostPicker
      :show="showSharePicker"
      :post-link="`bastyon://post?s=${sharePostTxid}`"
      @close="showSharePicker = false"
    />

    <!-- Channel info panel -->
    <ChannelInfoPanel
      :show="showChannelInfo"
      :channel="activeChannel"
      @close="showChannelInfo = false"
      @select-room="emit('back')"
    />
  </div>
</template>

<style scoped>
.msg-enter-other {
  animation: msg-in-other 0.25s ease-out both;
}
</style>
